/**
 * recovery-job-creator.ts — Agenda recovery_jobs a partir de eventos
 * InitiateCheckout dentro da janela [NOW()-60min, NOW()-6min].
 *
 * T-RECOVERY-002 (domain, Wave 2). Wave 1 (schema/migration 0054) já está
 * em prod. Wave 3 (rota/cron) consumirá este helper.
 *
 * O job-creator NÃO envia mensagens — apenas materializa rows em
 * `recovery_jobs` com `status='queued'` e `scheduled_for = received_at +
 * delay_min`. O sender (recovery-sender.ts) é responsável pelo dispatch.
 *
 * Semântica:
 *   - SELECT eventos `InitiateCheckout` na janela acima
 *   - que tenham `funnel_role == campaign.trigger_funnel_role`
 *   - cujo lead esteja em lifecycle 'lead' OU 'cliente' com supressão de
 *     compradores de `bait_*` (BR-RECOVERY: cliente que comprou outro
 *     `bait_*` no mesmo launch não recebe recovery do bait abandonado)
 *   - INSERT ON CONFLICT DO NOTHING (INV-RECOVERY-JOB-001)
 *
 * BRs / INVs honrados:
 *   - BR-RBAC-002: workspace_id no WHERE; nunca cross-workspace.
 *   - BR-IDENTITY: lead_id obrigatório no job (filtro lead_id IS NOT NULL).
 *   - BR-PRIVACY-001: logs só com counts e IDs internos (não-PII).
 *   - INV-RECOVERY-JOB-001: idempotência via UNIQUE
 *     (campaign_id, lead_id, step_index, trigger_event_id) +
 *     ON CONFLICT DO NOTHING.
 *
 * Limitação atual (W2): só agenda passo 0 da `campaign.steps[]`. Cadências
 * multi-step entram em W4+. Quando habilitarmos, basta substituir o
 * `(c.steps -> 0)` por um cross join com `jsonb_array_elements(c.steps)
 * WITH ORDINALITY`.
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
    // INV-RECOVERY-JOB-001: ON CONFLICT (campaign_id, lead_id, step_index,
    //   trigger_event_id) DO NOTHING.
    const insertResult = await db.execute(sql`
      WITH eligible AS (
        SELECT
          c.workspace_id,
          c.id AS campaign_id,
          e.lead_id,
          e.id AS trigger_event_id,
          0 AS step_index,
          ((c.steps -> 0) ->> 'template_id')::uuid AS template_id,
          (e.received_at + (((c.steps -> 0) ->> 'delay_min')::int * INTERVAL '1 minute')) AS scheduled_for
        FROM events e
        JOIN leads l ON l.id = e.lead_id
        JOIN recovery_campaigns c
          ON c.workspace_id = e.workspace_id
         AND c.launch_id = e.launch_id
         AND c.active = true
         AND e.payload->>'funnel_role' = c.trigger_funnel_role
        WHERE c.workspace_id = ${workspaceId}::uuid
          AND e.workspace_id = ${workspaceId}::uuid
          AND e.event_name = 'InitiateCheckout'
          AND e.received_at BETWEEN NOW() - INTERVAL '60 min' AND NOW() - INTERVAL '6 min'
          AND e.payload->'customer'->>'cell' IS NOT NULL
          AND e.lead_id IS NOT NULL
          AND (
            l.lifecycle_status = 'lead'
            OR (
              l.lifecycle_status = 'cliente'
              AND e.payload->>'status' = ANY (
                SELECT jsonb_array_elements_text(c.recoverable_statuses)
              )
              AND NOT EXISTS (
                SELECT 1
                FROM events e2
                WHERE e2.workspace_id = e.workspace_id
                  AND e2.lead_id = e.lead_id
                  AND e2.launch_id = e.launch_id
                  AND e2.event_name = 'Purchase'
                  AND e2.payload->>'funnel_role' LIKE 'bait_%'
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
        FROM eligible
        ON CONFLICT (campaign_id, lead_id, step_index, trigger_event_id)
          DO NOTHING
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*)::int FROM eligible) AS scanned,
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
