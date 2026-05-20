/**
 * recovery-sender.ts — Dispatcher de recovery_jobs prontos para envio via
 * API Unnichat (BSP WhatsApp).
 *
 * T-RECOVERY-002 / 002b (REWRITE 2026-05-20). Wave 3 conectará a um cron
 * handler.
 *
 * Responsabilidades:
 *   1. Query: jobs `status='queued'` com `scheduled_for <= NOW()` cuja
 *      hora atual no fuso da campanha caia dentro de [send_window_start,
 *      end]. SQL já filtra a janela em PG. Cap de 50 jobs por tick.
 *   2. Para cada job: aplica supressão final (cliente comprou outro
 *      `bait_*` após o job ser agendado) → marca `suppressed` sem enviar.
 *   3. DECRYPT phone (leads.phone_enc) e nome (leads.name plaintext OU
 *      leads.name_enc) usando masterKeyRegistry (HKDF workspace-scoped).
 *   4. Resolve placeholders do template a partir do nome decifrado.
 *   5. POST `https://unnichat.com.br/api/meta/templates` com Authorization
 *      header do env (que JÁ traz "Bearer " no valor — não concatenar).
 *   6. Atualiza o job: `sent` / `failed` / re-`queued` (retry transitório
 *      até attempts >= 5).
 *
 * --- Schema correto de `events` (notas da reescrita 002b) -------------
 *
 * Não existe `events.payload`. PII de comprador (telefone, nome) vive em
 * `leads.{phone_enc,name_enc,name,pii_key_version}`. Ver
 * recovery-job-creator.ts para a discussão completa.
 *
 * Reflexos no sender:
 *   - SELECT principal junta `leads` para puxar phone_enc + name(+enc) +
 *     pii_key_version.
 *   - `decryptPii()` (lib/pii.ts) é chamado per-row com
 *     masterKeyRegistry derivado de env.PII_MASTER_KEY_V1. Mesmo padrão
 *     de createLeadsQueryFns(connStr, masterKeyRegistry).
 *   - Falha de decrypt → mark job 'failed' com error='decrypt_failed'
 *     (sem retry: ciphertext corrupto ou key version desconhecida não
 *     melhoram com o tempo).
 *
 * BRs / INVs honrados:
 *   - BR-RBAC-002: workspace_id em todas as queries.
 *   - BR-PRIVACY-001: response_payload sanitizado antes de persistir;
 *     phone decifrado fica em memória durante o dispatch e jamais é
 *     logado (mesma postura do dispatcher Meta CAPI com email_hash etc.).
 *   - BR-PRIVACY-003: AES-256-GCM com HKDF workspace-scoped via
 *     decryptPii().
 *   - BR-PRIVACY-004: pii_key_version lido da row de leads para
 *     selecionar a chave correta no registry.
 *   - INV-RECOVERY-JOB-001: jamais re-inserimos jobs aqui — apenas
 *     UPDATE. Idempotência do creator não é afetada.
 *   - INV-RECOVERY-JOB-002: status final ∈ {queued, sent, failed,
 *     suppressed}. Sender não introduz outros.
 *   - INV-RECOVERY-JOB-003: status='sent' SEMPRE acompanhado de
 *     sent_at=NOW() no mesmo UPDATE.
 *
 * Política de retry (BR-DISPATCH-003 análogo):
 *   - 2xx                → sent
 *   - 4xx                → failed (permanente)
 *   - 5xx / rede / parse → mantém queued + attempts++; se attempts ≥ 5,
 *                          marca failed
 *   - decrypt_failed     → failed (permanente; sem retry)
 *   - phone vazio        → failed (permanente; sem retry)
 */

import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';
import { safeLog, sanitize } from '../middleware/sanitize-logs.js';
import { type MasterKeyRegistry, decryptPii } from './pii.js';
import type {
  RecoveryTemplateSlot,
  SendResult,
  UnnichatDispatchInput,
  UnnichatDispatchResult,
  UnnichatTemplateParam,
} from './recovery-types.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const UNNICHAT_TEMPLATES_URL = 'https://unnichat.com.br/api/meta/templates';
const MAX_JOBS_PER_TICK = 50;
const MAX_ATTEMPTS_BEFORE_FAIL = 5;
/** Tamanho máximo de body em string mantido em log/response_payload. */
const MAX_BODY_PERSIST_BYTES = 4_000;

// ---------------------------------------------------------------------------
// Shape interno: row vinda do SELECT principal
// ---------------------------------------------------------------------------

interface PendingJobRow {
  job_id: string;
  lead_id: string;
  attempts: number;
  unnichat_template_id: string;
  body_params: unknown;
  url_button_params: unknown;
  // PII criptografada — decifrada em runtime no sender, nunca logada.
  phone_enc: string | null;
  name_plain: string | null;
  name_enc: string | null;
  pii_key_version: number;
  launch_id: string | null;
  trigger_event_id: string;
  job_created_at: string; // ISO timestamp; usado na checagem de supressão
}

// ---------------------------------------------------------------------------
// Env shape — sender precisa do PII_MASTER_KEY_V1 para decifrar phone+nome.
// Mantemos um shape estreito (não pega o Env inteiro do worker) para o
// helper continuar testável.
// ---------------------------------------------------------------------------

export interface RecoverySenderEnv {
  /** Header Authorization completo (já com "Bearer "). */
  UNNICHAT_API_KEY: string;
  /** Hex 64-char master key (BR-PRIVACY-003/004). */
  PII_MASTER_KEY_V1?: string;
}

// ---------------------------------------------------------------------------
// dispatchToUnnichat — função pura (sem DB)
// ---------------------------------------------------------------------------

/**
 * Envia 1 mensagem template via API Unnichat.
 *
 * NÃO joga em 4xx/5xx — o caller (sendPendingRecoveryJobs) precisa do
 * status para decidir a transição de estado do job. Network errors viram
 * `{ ok: false, status: 0 }`.
 *
 * BR-PRIVACY-001: body é sanitizado antes de retornar.
 *
 * @param input  credenciais + payload já resolvido
 * @param fetchFn injectable fetch (default global) — facilita testes na W7
 */
export async function dispatchToUnnichat(
  input: UnnichatDispatchInput,
  fetchFn: typeof fetch = fetch,
): Promise<UnnichatDispatchResult> {
  // OQ resolvida em W3 (T-RECOVERY-003): payload Unnichat é camelCase.
  // Fonte: bundle do app https://unnichat.com.br/assets/index-4e91ad0e.js
  //   — 57 ocorrências de `templateId`, 41 de `bodyParameters`, 29 de
  //   `urlButtonParameters`, 0 ocorrências das variantes snake_case.
  // W2 inferiu snake_case por engano; corrigido aqui antes do go-live.
  const payload = {
    phone: input.phone,
    templateId: input.unnichatTemplateId,
    bodyParameters: input.bodyParameters,
    urlButtonParameters: input.urlButtonParameters,
  };

  let response: Response;
  try {
    response = await fetchFn(UNNICHAT_TEMPLATES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // `input.apiKey` já contém o prefixo "Bearer " — não concatenar.
        Authorization: input.apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    return {
      ok: false,
      status: 0,
      body: null,
      error:
        networkError instanceof Error
          ? networkError.message.slice(0, 200)
          : 'network_error',
    };
  }

  const status = response.status;

  // Defensive parsing — Unnichat às vezes responde texto em erros.
  let parsed: unknown = null;
  let rawText: string | null = null;
  try {
    const text = await response.text();
    rawText = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { _raw: text.slice(0, MAX_BODY_PERSIST_BYTES) };
      }
    }
  } catch {
    parsed = null;
  }

  // BR-PRIVACY-001: passa o body pelo sanitizador antes de devolver.
  const sanitizedBody = sanitize(parsed);

  if (response.ok) {
    const messageId = extractMessageId(parsed);
    return {
      ok: true,
      status,
      messageId,
      body: sanitizedBody,
    };
  }

  // Non-2xx: monta `error` curto a partir do que veio (sem PII — passou no
  // sanitizer).
  const errorMsg = summarizeError(parsed, rawText, status);
  return {
    ok: false,
    status,
    body: sanitizedBody,
    error: errorMsg,
  };
}

// ---------------------------------------------------------------------------
// sendPendingRecoveryJobs — orquestra a passada do cron
// ---------------------------------------------------------------------------

/**
 * Pega até `MAX_JOBS_PER_TICK` jobs prontos do workspace e tenta enviá-los.
 *
 * O SQL já filtra:
 *   - workspace_id
 *   - status='queued'
 *   - scheduled_for <= NOW()
 *   - hora local da campanha dentro de [send_window_start, send_window_end]
 *   - leads.phone_enc IS NOT NULL (defesa em profundidade; creator já
 *     impõe o mesmo)
 *
 * Para cada job, aplicamos:
 *   1. Supressão final (compra de bait_* posterior ao agendamento) →
 *      status='suppressed'.
 *   2. Decrypt do phone (e nome) com decryptPii() workspace-scoped.
 *      Falha → status='failed' com error='decrypt_failed'.
 *   3. Sanitização do telefone (`replace(/\D+/g, '')`). Vazio → failed.
 *   4. Resolução de placeholders (body + url button).
 *   5. POST Unnichat + atualização do job.
 *
 * BR-RBAC-002: workspace_id é argumento e filtra todas as queries.
 *
 * @param db          conexão Drizzle
 * @param workspaceId tenant anchor
 * @param env         deve carregar UNNICHAT_API_KEY (header completo, com
 *                    "Bearer ") e PII_MASTER_KEY_V1 (hex 64 chars).
 * @param fetchFn     injectable para testes (default global fetch)
 */
export async function sendPendingRecoveryJobs(
  db: Db,
  workspaceId: string,
  env: RecoverySenderEnv,
  fetchFn: typeof fetch = fetch,
): Promise<SendResult> {
  let sent = 0;
  let failed = 0;
  let suppressed = 0;
  // SQL já filtra a janela em PG; mantemos o contador zerado para shape
  // estável da resposta (a UI/cron loga consistente entre ticks).
  const skippedWindow = 0;

  // BR-PRIVACY-003/004: master key registry. Sem chave válida, o sender
  // nem tenta — falha rápido e loga sem expor key value.
  if (!env.PII_MASTER_KEY_V1) {
    safeLog('error', {
      event: 'recovery_sender_missing_master_key',
      workspace_id: workspaceId,
    });
    return { workspaceId, sent: 0, failed: 0, suppressed: 0, skippedWindow: 0 };
  }
  const masterKeyRegistry: MasterKeyRegistry = { 1: env.PII_MASTER_KEY_V1 };

  let rows: PendingJobRow[];
  try {
    // Query principal: junta job → template → campaign → event gatilho →
    //   lead (phone_enc + name + name_enc + pii_key_version).
    // BR-RBAC-002: workspace_id no WHERE.
    // A janela é avaliada em PG: (NOW() AT TIME ZONE c.send_window_tz)::time
    //   BETWEEN c.send_window_start AND c.send_window_end.
    const queryResult = await db.execute(sql`
      SELECT
        rj.id AS job_id,
        rj.lead_id,
        rj.attempts,
        rj.trigger_event_id,
        rj.created_at AS job_created_at,
        rt.unnichat_template_id,
        rt.body_params,
        rt.url_button_params,
        e.launch_id,
        l.phone_enc,
        l.name AS name_plain,
        l.name_enc,
        l.pii_key_version
      FROM recovery_jobs rj
      JOIN recovery_templates rt ON rt.id = rj.template_id
      JOIN recovery_campaigns c  ON c.id = rj.campaign_id
      JOIN events e              ON e.id = rj.trigger_event_id
      JOIN leads l               ON l.id = rj.lead_id
      WHERE rj.workspace_id = ${workspaceId}::uuid
        AND rj.status = 'queued'
        AND rj.scheduled_for <= NOW()
        AND (NOW() AT TIME ZONE c.send_window_tz)::time
            BETWEEN c.send_window_start AND c.send_window_end
        AND l.phone_enc IS NOT NULL
      ORDER BY rj.scheduled_for ASC
      LIMIT ${MAX_JOBS_PER_TICK}
    `);
    rows = queryResult as unknown as PendingJobRow[];
  } catch (err) {
    safeLog('error', {
      event: 'recovery_sender_query_failed',
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return { workspaceId, sent: 0, failed: 0, suppressed: 0, skippedWindow: 0 };
  }

  for (const row of rows) {
    // ---------------------------------------------------------------
    // 1. Supressão final: lead comprou outro bait_* após o agendamento.
    //    Faz UPDATE direto para 'suppressed' (INV-RECOVERY-JOB-002).
    // ---------------------------------------------------------------
    const suppressedNow = await isLeadSuppressed(db, {
      workspaceId,
      leadId: row.lead_id,
      launchId: row.launch_id,
      jobCreatedAt: row.job_created_at,
    });

    if (suppressedNow) {
      const ok = await markJobSuppressed(db, workspaceId, row.job_id);
      if (ok) suppressed++;
      continue;
    }

    // ---------------------------------------------------------------
    // 2. Decrypt phone. BR-PRIVACY-003/004: AES-GCM workspace-scoped.
    //    decryptPii() retorna Result<string, PiiError>.
    // ---------------------------------------------------------------
    if (!row.phone_enc) {
      // Defesa em profundidade — a SELECT já filtra IS NOT NULL.
      await markJobFailed(db, workspaceId, row.job_id, {
        error: 'missing_phone_enc',
        responseBody: null,
        attempts: row.attempts + 1,
      });
      failed++;
      continue;
    }

    const phoneResult = await decryptPii(
      row.phone_enc,
      workspaceId,
      masterKeyRegistry,
      row.pii_key_version,
    );
    if (!phoneResult.ok) {
      // BR-PRIVACY-001: não logar phone_enc nem error.message detalhada
      // (decryption_failed já é genérico). Só code + IDs internos.
      safeLog('warn', {
        event: 'recovery_sender_phone_decrypt_failed',
        workspace_id: workspaceId,
        job_id: row.job_id,
        lead_id: row.lead_id,
        code: phoneResult.error.code,
      });
      await markJobFailed(db, workspaceId, row.job_id, {
        error: `decrypt_failed:${phoneResult.error.code}`,
        responseBody: null,
        attempts: row.attempts + 1,
      });
      failed++;
      continue;
    }

    const phoneDigits = phoneResult.value.replace(/\D+/g, '');
    if (phoneDigits.length === 0) {
      await markJobFailed(db, workspaceId, row.job_id, {
        error: 'invalid_phone',
        responseBody: null,
        attempts: row.attempts + 1,
      });
      failed++;
      continue;
    }

    // ---------------------------------------------------------------
    // 3. Decrypt nome (ADR-034: prefer plaintext leads.name).
    //    Falha de decrypt do nome NÃO bloqueia o envio — o slot
    //    'contactName' usa fallback 'amigo(a)'.
    // ---------------------------------------------------------------
    let customerName: string | null = row.name_plain;
    if (!customerName && row.name_enc) {
      const nameResult = await decryptPii(
        row.name_enc,
        workspaceId,
        masterKeyRegistry,
        row.pii_key_version,
      );
      if (nameResult.ok) {
        customerName = nameResult.value;
      } else {
        // Não bloqueia: o resolveSlot vai cair no fallback.
        safeLog('warn', {
          event: 'recovery_sender_name_decrypt_failed',
          workspace_id: workspaceId,
          job_id: row.job_id,
          lead_id: row.lead_id,
          code: nameResult.error.code,
        });
      }
    }

    // ---------------------------------------------------------------
    // 4. Resolve placeholders.
    //    `offer_hash` ficou como token livre no template seed:
    //    `?off=Fn4XA0` é o fallback hardcoded em
    //    `url_button_params[0].fallback`. Em waves futuras podemos
    //    derivar de custom_data, mas hoje o fallback cobre 100% das
    //    rows e o creator não materializa offer_hash. Mantemos
    //    offerHash='' (resolveSlot vai usar slot.fallback).
    // ---------------------------------------------------------------
    const bodySlots = coerceSlotArray(row.body_params);
    const urlSlots = coerceSlotArray(row.url_button_params);
    const firstName = extractFirstName(customerName);
    const offerHash = '';

    const bodyParameters: UnnichatTemplateParam[] = bodySlots.map((slot) =>
      resolveSlot(slot, { firstName, offerHash }),
    );
    const urlButtonParameters: UnnichatTemplateParam[] = urlSlots.map((slot) =>
      resolveSlot(slot, { firstName, offerHash }),
    );

    // ---------------------------------------------------------------
    // 5. POST Unnichat.
    // ---------------------------------------------------------------
    const result = await dispatchToUnnichat(
      {
        apiKey: env.UNNICHAT_API_KEY,
        phone: phoneDigits,
        unnichatTemplateId: row.unnichat_template_id,
        bodyParameters,
        urlButtonParameters,
      },
      fetchFn,
    );

    // ---------------------------------------------------------------
    // 6. Atualiza job conforme política de retry.
    // ---------------------------------------------------------------
    const nextAttempts = row.attempts + 1;
    const safeResponse = clampResponseForPersist(result.body);

    if (result.ok) {
      // INV-RECOVERY-JOB-003: status='sent' SEMPRE com sent_at=NOW() no
      //   mesmo UPDATE.
      const ok = await markJobSent(db, workspaceId, row.job_id, {
        unnichatMessageId: result.messageId ?? null,
        responseBody: safeResponse,
        attempts: nextAttempts,
      });
      if (ok) sent++;
      continue;
    }

    // Não-OK
    const isPermanent = result.status >= 400 && result.status < 500;
    const exceededAttempts = nextAttempts >= MAX_ATTEMPTS_BEFORE_FAIL;

    if (isPermanent || exceededAttempts) {
      await markJobFailed(db, workspaceId, row.job_id, {
        error: (result.error ?? `status_${result.status}`).slice(0, 200),
        responseBody: safeResponse,
        attempts: nextAttempts,
      });
      failed++;
    } else {
      // Transitório: mantém queued + incrementa attempts.
      await markJobTransient(db, workspaceId, row.job_id, {
        error: (result.error ?? `status_${result.status}`).slice(0, 200),
        responseBody: safeResponse,
        attempts: nextAttempts,
      });
      // Não conta em sent/failed/suppressed — cron tentará de novo.
    }
  }

  safeLog('info', {
    event: 'recovery_sender_tick_done',
    workspace_id: workspaceId,
    sent,
    failed,
    suppressed,
    skipped_window: skippedWindow,
    scanned: rows.length,
  });

  return { workspaceId, sent, failed, suppressed, skippedWindow };
}

// ---------------------------------------------------------------------------
// Helpers internos — DB transitions
// ---------------------------------------------------------------------------

/**
 * BR-RECOVERY (W3 doc): cliente que comprou OUTRO `bait_*` no mesmo launch
 * APÓS o job ter sido agendado não recebe a recuperação do bait abandonado.
 *
 * received_at > rj.created_at é a condição: somente compras posteriores ao
 * agendamento contam (compras anteriores já teriam impedido o creator de
 * inserir o job, então o filtro também é defensivo contra race entre
 * creator e sender).
 *
 * Funnel role: mesma derivação do creator — COALESCE(custom_data, JOIN
 * via products + launch_products). Cobre Guru (direct) e OnProfit (via
 * product_id).
 */
async function isLeadSuppressed(
  db: Db,
  args: {
    workspaceId: string;
    leadId: string;
    launchId: string | null;
    jobCreatedAt: string;
  },
): Promise<boolean> {
  if (!args.launchId) return false;
  try {
    const res = await db.execute(sql`
      SELECT 1
      FROM events e2
      WHERE e2.workspace_id = ${args.workspaceId}::uuid
        AND e2.lead_id      = ${args.leadId}::uuid
        AND e2.launch_id    = ${args.launchId}::uuid
        AND e2.event_name   = 'Purchase'
        AND e2.received_at  > ${args.jobCreatedAt}::timestamptz
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
      LIMIT 1
    `);
    return (res as unknown as unknown[]).length > 0;
  } catch (err) {
    safeLog('warn', {
      event: 'recovery_suppression_check_failed',
      workspace_id: args.workspaceId,
      lead_id: args.leadId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    // Em dúvida, NÃO suprime — deixa o sender tentar (mais conservador
    // para o operador; falha de DB não cancela campanhas).
    return false;
  }
}

async function markJobSuppressed(
  db: Db,
  workspaceId: string,
  jobId: string,
): Promise<boolean> {
  try {
    // INV-RECOVERY-JOB-002: status='suppressed' é válido.
    // BR-RBAC-002: workspace_id no WHERE.
    await db.execute(sql`
      UPDATE recovery_jobs
      SET status = 'suppressed',
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId}::uuid
        AND id = ${jobId}::uuid
        AND status = 'queued'
    `);
    return true;
  } catch (err) {
    safeLog('error', {
      event: 'recovery_mark_suppressed_failed',
      workspace_id: workspaceId,
      job_id: jobId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return false;
  }
}

async function markJobSent(
  db: Db,
  workspaceId: string,
  jobId: string,
  args: {
    unnichatMessageId: string | null;
    responseBody: unknown;
    attempts: number;
  },
): Promise<boolean> {
  try {
    // INV-RECOVERY-JOB-003: status='sent' → sent_at NOT NULL no mesmo UPDATE.
    // BR-PRIVACY-001: responseBody já vem sanitizado pelo caller.
    await db.execute(sql`
      UPDATE recovery_jobs
      SET status = 'sent',
          sent_at = NOW(),
          unnichat_message_id = ${args.unnichatMessageId},
          response_payload = ${JSON.stringify(args.responseBody ?? null)}::jsonb,
          attempts = ${args.attempts},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId}::uuid
        AND id = ${jobId}::uuid
        AND status = 'queued'
    `);
    return true;
  } catch (err) {
    safeLog('error', {
      event: 'recovery_mark_sent_failed',
      workspace_id: workspaceId,
      job_id: jobId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return false;
  }
}

async function markJobFailed(
  db: Db,
  workspaceId: string,
  jobId: string,
  args: {
    error: string;
    responseBody: unknown;
    attempts: number;
  },
): Promise<boolean> {
  try {
    // INV-RECOVERY-JOB-002: status='failed' é válido.
    await db.execute(sql`
      UPDATE recovery_jobs
      SET status = 'failed',
          error = ${args.error},
          response_payload = ${JSON.stringify(args.responseBody ?? null)}::jsonb,
          attempts = ${args.attempts},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId}::uuid
        AND id = ${jobId}::uuid
        AND status = 'queued'
    `);
    return true;
  } catch (err) {
    safeLog('error', {
      event: 'recovery_mark_failed_failed',
      workspace_id: workspaceId,
      job_id: jobId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return false;
  }
}

async function markJobTransient(
  db: Db,
  workspaceId: string,
  jobId: string,
  args: {
    error: string;
    responseBody: unknown;
    attempts: number;
  },
): Promise<boolean> {
  try {
    // INV-RECOVERY-JOB-002: mantém status='queued' (próxima passada tenta).
    await db.execute(sql`
      UPDATE recovery_jobs
      SET error = ${args.error},
          response_payload = ${JSON.stringify(args.responseBody ?? null)}::jsonb,
          attempts = ${args.attempts},
          updated_at = NOW()
      WHERE workspace_id = ${workspaceId}::uuid
        AND id = ${jobId}::uuid
        AND status = 'queued'
    `);
    return true;
  } catch (err) {
    safeLog('error', {
      event: 'recovery_mark_transient_failed',
      workspace_id: workspaceId,
      job_id: jobId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers internos — resolução de placeholders
// ---------------------------------------------------------------------------

function coerceSlotArray(value: unknown): RecoveryTemplateSlot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is RecoveryTemplateSlot =>
      typeof v === 'object' && v !== null && 'type' in v,
  );
}

function extractFirstName(fullName: string | null): string {
  if (!fullName) return '';
  const trimmed = fullName.trim();
  if (!trimmed) return '';
  const first = trimmed.split(/\s+/)[0];
  return first ?? '';
}

/**
 * Resolve um slot do template para o payload final `{ type: 'text', text }`.
 *
 * Regras:
 *   - 'contactName' → firstName || fallback || 'amigo(a)'
 *   - qualquer outro tipo → fallback || ''
 *
 * Substituição simples de token `${offer_hash}` no fallback.
 */
function resolveSlot(
  slot: RecoveryTemplateSlot,
  ctx: { firstName: string; offerHash: string },
): UnnichatTemplateParam {
  let text = '';
  if (slot.type === 'contactName') {
    text = ctx.firstName || slot.fallback || 'amigo(a)';
  } else {
    text = slot.fallback ?? '';
  }
  // Token substitution (string simples, sem regex complexa para evitar
  // surprise injection — só `${offer_hash}`).
  if (text.includes('${offer_hash}')) {
    text = text.split('${offer_hash}').join(ctx.offerHash);
  }
  return { type: 'text', text };
}

// ---------------------------------------------------------------------------
// Helpers internos — resposta HTTP
// ---------------------------------------------------------------------------

function extractMessageId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const key of ['messageId', 'message_id', 'id'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function summarizeError(
  parsed: unknown,
  rawText: string | null,
  status: number,
): string {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail'] as const) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) {
        return `status_${status}: ${v}`.slice(0, 200);
      }
    }
  }
  if (rawText && rawText.length > 0) {
    return `status_${status}: ${rawText.slice(0, 150)}`;
  }
  return `status_${status}`;
}

/**
 * Limita o tamanho do body antes de persistir em response_payload. Defesa
 * em profundidade contra payloads grandes (a sanitização já cobre PII).
 */
function clampResponseForPersist(body: unknown): unknown {
  if (body === null || body === undefined) return null;
  try {
    const json = JSON.stringify(body);
    if (json.length <= MAX_BODY_PERSIST_BYTES) return body;
    return {
      _truncated: true,
      _bytes: json.length,
      preview: json.slice(0, MAX_BODY_PERSIST_BYTES),
    };
  } catch {
    return { _unserializable: true };
  }
}
