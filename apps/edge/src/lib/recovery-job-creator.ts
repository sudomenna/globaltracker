/**
 * recovery-job-creator.ts — Agenda recovery_jobs a partir de eventos
 * InitiateCheckout dentro da janela [NOW()-60min, NOW()-6min].
 *
 * T-RECOVERY-002 / 002b (REWRITE 2026-05-20). Wave 1 (schema/migration
 * 0054) já está em prod. Wave 3 (rota/cron) consumirá este helper.
 *
 * O job-creator NÃO envia mensagens — apenas materializa rows em
 * `recovery_jobs` com `status='queued'` e `scheduled_for = received_at +
 * delay_min`. O sender (recovery-sender.ts) é responsável pelo dispatch.
 *
 * --- Schema correto de `events` (notas da reescrita 002b) -------------
 *
 * `events` é a tabela NORMALIZADA. Não existe coluna `payload` com o
 * webhook bruto — os dados vivem em colunas dedicadas:
 *   - events.event_source     ('webhook:onprofit' | 'webhook:guru' | ...)
 *   - events.custom_data jsonb (amount, currency, product_id, ...)
 *   - events.user_data jsonb   (em/ph hashes, geo_*; sem PII em claro)
 *   - events.attribution jsonb
 *
 * E os dados de comprador (PII em claro) vivem em `leads`:
 *   - leads.phone_enc (AES-GCM base64url) — sempre filtrar IS NOT NULL
 *   - leads.email_enc, leads.name_enc, leads.name (plaintext, ADR-034)
 *   - leads.pii_key_version (usado em decryptPii)
 *
 * Por que isso importa para o creator: a query precisa derivar
 * `funnel_role` a partir do evento, e Guru/OnProfit fazem isso de jeitos
 * diferentes (ver "Derivação de funnel_role" abaixo).
 *
 * --- Derivação de funnel_role por provider ----------------------------
 *
 * Guru (webhook:guru):
 *   `guru-raw-events-processor.ts` injeta `funnel_role` diretamente em
 *   `events.custom_data->>'funnel_role'`. Para eventos Guru POSTERIORES
 *   à entrega do resolver (2026-05-09+), basta ler do custom_data.
 *
 * OnProfit (webhook:onprofit):
 *   `onprofit-raw-events-processor.ts` NÃO grava funnel_role em
 *   custom_data. O caminho é JOIN em chain:
 *     products      (workspace_id, external_provider='onprofit',
 *                    external_product_id = custom_data->>'product_id')
 *     launch_products (workspace_id, launch_id, product_id)
 *   `launch_products.launch_role` é o funnel_role.
 *
 * Solução: COALESCE(custom_data->>'funnel_role', subquery_join). Cobre
 * ambos os providers sem CASE explícito por event_source.
 *
 * --- Status do checkout por provider (observação 002b) ----------------
 *
 * OnProfit: `custom_data->>'onprofit_status'` ∈ {'WAITING',
 *   'CART_ABANDONED','PAID',...}. Compatível com
 *   recovery_campaigns.recoverable_statuses (default seed inclui WAITING
 *   e CART_ABANDONED).
 *
 * Guru: NÃO há campo de status em custom_data. Eventos
 *   InitiateCheckout do Guru só são gerados quando o webhook é
 *   `abandoned`/`canceled` (transações não-aprovadas) — a presença do
 *   evento JÁ implica abandono. Portanto, materializamos a constante
 *   'CART_ABANDONED' no SQL (valor canônico do enum, presente no seed
 *   default de recoverable_statuses).
 *
 *   Confirmado lendo `guru-raw-events-processor.ts` + queries diretas
 *   em produção (2026-05-20): rows webhook:guru / InitiateCheckout não
 *   gravam `*_status` em custom_data. A única assinatura temporal é
 *   `custom_data.dates.canceled_at` (não usada aqui — overkill).
 *
 *   Se um dia o ingestor Guru passar a gravar status, basta trocar a
 *   constante por `custom_data->>'guru_status'` na CASE.
 *
 * Semântica:
 *   - SELECT eventos `InitiateCheckout` na janela [-60min, -6min]
 *   - funnel_role resolvido == campaign.trigger_funnel_role
 *   - lifecycle 'lead' OU ('cliente' AND status ∈ recoverable_statuses
 *       AND NÃO existe Purchase de OUTRO bait_* no mesmo launch)
 *   - INSERT ON CONFLICT DO NOTHING (INV-RECOVERY-JOB-001)
 *
 * BRs / INVs honrados:
 *   - BR-RBAC-002: workspace_id em TODOS os WHERE/JOIN; jamais
 *     cross-workspace.
 *   - BR-IDENTITY: lead_id IS NOT NULL + leads.phone_enc IS NOT NULL —
 *     recovery exige lead resolvido com telefone criptografado em mãos.
 *   - BR-PRIVACY-001: logs só com counts e IDs internos; nada de PII
 *     (mesmo phone só sai do envelope no sender, dentro do dispatch).
 *   - INV-RECOVERY-JOB-001: idempotência via UNIQUE
 *     (campaign_id, lead_id, step_index, trigger_event_id) +
 *     ON CONFLICT DO NOTHING.
 *
 * Limitação atual (W2/W2b): só agenda passo 0 da `campaign.steps[]`.
 * Cadências multi-step entram em W4+. Quando habilitarmos, basta
 * substituir `(c.steps -> 0)` por cross join com
 * `jsonb_array_elements(c.steps) WITH ORDINALITY`.
 */

import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';
import { safeLog } from '../middleware/sanitize-logs.js';
import type { CreatePendingJobsResult } from './recovery-types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cria recovery_jobs pendentes para um workspace.
 *
 * Chamado por um cron tick (W3). Cada execução é idempotente:
 * INSERT ... ON CONFLICT DO NOTHING evita duplicação se o tick rodar duas
 * vezes na mesma janela.
 *
 * Janela [NOW()-60min, NOW()-6min]:
 *   - 6min: lower bound de "abandono confirmado" — abaixo disso o usuário
 *     ainda pode estar completando o checkout.
 *   - 60min: upper bound de elegibilidade — abandonos mais velhos não
 *     entram em recovery (decisão de produto, BR-RECOVERY documentada em
 *     W3+).
 *
 * Não retorna jobs criados (apenas contadores) — observabilidade detalhada
 * fica a cargo da UI do Control Plane (W4+).
 *
 * @param db          conexão Drizzle (postgres-js)
 * @param workspaceId tenant anchor
 * @returns counts (created/scanned) para observabilidade do cron.
 */
export async function createPendingRecoveryJobs(
  db: Db,
  workspaceId: string,
): Promise<CreatePendingJobsResult> {
  try {
    // Estratégia: CTE `eligible` materializa o conjunto de eventos elegíveis
    // (cobrindo o `scanned`), depois INSERT ... SELECT FROM eligible com
    // ON CONFLICT DO NOTHING (cobrindo o `created`). Uma única query, dois
    // contadores precisos via RETURNING.
    //
    // BR-RBAC-002: workspace_id no WHERE em ambas as branches (events e
    //   recovery_campaigns).
    // BR-IDENTITY: e.lead_id IS NOT NULL — recovery exige lead resolvido.
    //   l.phone_enc IS NOT NULL — sem telefone criptografado não há como
    //   o sender despachar para o WhatsApp (a alternativa fb seria scan
    //   por user_data.ph, mas isso é hash — não decifrável).
    // INV-RECOVERY-JOB-001: ON CONFLICT (campaign_id, lead_id, step_index,
    //   trigger_event_id) DO NOTHING.
    //
    // Funnel role: COALESCE(custom_data->>'funnel_role', JOIN via
    //   products + launch_products). Cobre Guru (direct) e OnProfit
    //   (indireto pelo product_id).
    //
    // Status: CASE por event_source.
    //   - webhook:onprofit → custom_data->>'onprofit_status'
    //   - webhook:guru     → constante 'CART_ABANDONED' (Guru não grava
    //     status; presença do InitiateCheckout já implica abandono).
    //   - outros providers → NULL (não passam no ANY check; ficam só
    //     elegíveis pelo branch 'lead').
    const insertResult = await db.execute(sql`
      WITH eligible AS (
        SELECT
          c.workspace_id,
          c.id AS campaign_id,
          e.lead_id,
          e.id AS trigger_event_id,
          0 AS step_index,
          ((c.steps -> 0) ->> 'template_id')::uuid AS template_id,
          (e.received_at + (((c.steps -> 0) ->> 'delay_min')::int * INTERVAL '1 minute')) AS scheduled_for,
          -- Resolve funnel_role: Guru grava direto em custom_data;
          -- OnProfit exige JOIN products → launch_products via product_id.
          COALESCE(
            e.custom_data->>'funnel_role',
            (
              SELECT lp.launch_role
              FROM products p
              JOIN launch_products lp
                ON lp.workspace_id = p.workspace_id
               AND lp.launch_id    = e.launch_id
               AND lp.product_id   = p.id
              WHERE p.workspace_id        = e.workspace_id
                AND p.external_provider   = split_part(e.event_source, ':', 2)
                AND p.external_product_id = (e.custom_data->>'product_id')
              LIMIT 1
            )
          ) AS resolved_funnel_role,
          -- Resolve status do checkout-provider.
          CASE
            WHEN e.event_source = 'webhook:onprofit' THEN e.custom_data->>'onprofit_status'
            WHEN e.event_source = 'webhook:guru'     THEN 'CART_ABANDONED'
            ELSE NULL
          END AS resolved_status,
          e.received_at,
          c.trigger_funnel_role,
          c.recoverable_statuses,
          l.lifecycle_status
        FROM events e
        JOIN leads l ON l.id = e.lead_id
        JOIN recovery_campaigns c
          ON c.workspace_id = e.workspace_id
         AND c.launch_id    = e.launch_id
         AND c.active       = true
        WHERE c.workspace_id = ${workspaceId}::uuid
          AND e.workspace_id = ${workspaceId}::uuid
          AND e.event_name   = 'InitiateCheckout'
          AND e.received_at  BETWEEN NOW() - INTERVAL '60 min' AND NOW() - INTERVAL '6 min'
          AND e.lead_id      IS NOT NULL
          -- BR-IDENTITY: precisa de phone criptografado para o sender decifrar.
          AND l.phone_enc    IS NOT NULL
      ),
      filtered AS (
        SELECT *
        FROM eligible
        WHERE resolved_funnel_role = trigger_funnel_role
          AND (
            lifecycle_status = 'lead'
            OR (
              lifecycle_status = 'cliente'
              AND resolved_status = ANY (
                SELECT jsonb_array_elements_text(recoverable_statuses)
              )
              -- Supressão: cliente que comprou OUTRO bait_* no MESMO launch
              -- não recebe recovery do bait abandonado. Mesma derivação de
              -- funnel_role (COALESCE direct/JOIN).
              AND NOT EXISTS (
                SELECT 1
                FROM events e2
                WHERE e2.workspace_id = eligible.workspace_id
                  AND e2.lead_id      = eligible.lead_id
                  AND e2.launch_id    = (
                    SELECT c2.launch_id
                    FROM recovery_campaigns c2
                    WHERE c2.id = eligible.campaign_id
                  )
                  AND e2.event_name = 'Purchase'
                  AND COALESCE(
                    e2.custom_data->>'funnel_role',
                    (
                      SELECT lp2.launch_role
                      FROM products p2
                      JOIN launch_products lp2
                        ON lp2.workspace_id = p2.workspace_id
                       AND lp2.launch_id    = e2.launch_id
                       AND lp2.product_id   = p2.id
                      WHERE p2.workspace_id        = e2.workspace_id
                        AND p2.external_provider   = split_part(e2.event_source, ':', 2)
                        AND p2.external_product_id = (e2.custom_data->>'product_id')
                      LIMIT 1
                    )
                  ) LIKE 'bait_%'
              )
            )
          )
      ),
      inserted AS (
        INSERT INTO recovery_jobs (
          workspace_id, campaign_id, lead_id, trigger_event_id,
          step_index, template_id, scheduled_for
        )
        SELECT
          workspace_id, campaign_id, lead_id, trigger_event_id,
          step_index, template_id, scheduled_for
        FROM filtered
        ON CONFLICT (campaign_id, lead_id, step_index, trigger_event_id)
          DO NOTHING
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*)::int FROM filtered) AS scanned,
        (SELECT COUNT(*)::int FROM inserted) AS created
    `);

    // postgres-js retorna array-like de rows; a CTE acima sempre devolve
    // exatamente 1 row com os dois counts.
    const rows = insertResult as unknown as Array<{
      scanned: number | string;
      created: number | string;
    }>;
    const first = rows[0];
    const scanned = first ? Number(first.scanned ?? 0) : 0;
    const created = first ? Number(first.created ?? 0) : 0;

    // BR-PRIVACY-001: workspace_id e counts são não-PII — safe em log.
    safeLog('info', {
      event: 'recovery_jobs_created',
      workspace_id: workspaceId,
      scanned,
      created,
    });

    return { workspaceId, scanned, created };
  } catch (err) {
    // BR-PRIVACY-001: workspace_id é UUID interno — safe em log.
    safeLog('error', {
      event: 'recovery_jobs_create_failed',
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    // Erro é caminho excepcional; retornamos contadores neutros para o
    // cron decidir alertar. Não bubblamos para o cron derrubar outros
    // workspaces.
    return { workspaceId, scanned: 0, created: 0 };
  }
}
