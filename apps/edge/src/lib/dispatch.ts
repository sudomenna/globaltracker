/**
 * Dispatch domain helpers — MOD-DISPATCH lifecycle management.
 *
 * Orchestrates the lifecycle of dispatch_jobs and dispatch_attempts:
 * - Deterministic idempotency key derivation (INV-DISPATCH-002)
 * - Exponential backoff with jitter (INV-DISPATCH-007)
 * - Atomic lock before processing (INV-DISPATCH-008)
 * - Dead-letter queue logic (INV-DISPATCH-003)
 *
 * All functions use explicit DI for `db` — no singleton imports.
 * Compatible with Cloudflare Workers runtime (no Node-specific APIs).
 *
 * BR-DISPATCH-001: idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
 * BR-DISPATCH-002: atomic lock — UPDATE status='pending'→'processing' before calling external platform
 * BR-DISPATCH-003: backoff exponential + jitter; max 5 attempts then dead_letter
 * BR-DISPATCH-004: skip_reason required when status='skipped'
 * BR-DISPATCH-005: dead_letter does not auto-reprocess
 */

import type { Db } from '@globaltracker/db';
import { dispatchAttempts, dispatchJobs } from '@globaltracker/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { sanitizeDispatchPayload } from './dispatch-payload-sanitize.js';
import { jsonb } from './jsonb-cast.js';

/**
 * Helper: prepara request/response payloads para gravação em
 * dispatch_attempts. Aplica sanitização (IP redact) idempotente —
 * mesmo que o dispatcher tenha esquecido de redactar, esta camada
 * captura. Retorna sempre `{}` (não-nulo, jsonb-object) quando o
 * dispatcher não populou — preserva contrato anterior do schema.
 */
function buildAttemptPayloads(
  result: { request?: unknown; response?: unknown } | undefined,
): {
  request: ReturnType<typeof jsonb>;
  response: ReturnType<typeof jsonb>;
} {
  const req =
    result?.request !== undefined
      ? (sanitizeDispatchPayload(result.request) as Record<string, unknown>)
      : {};
  const res =
    result?.response !== undefined
      ? (sanitizeDispatchPayload(result.response) as Record<string, unknown>)
      : {};
  return { request: jsonb(req), response: jsonb(res) };
}

// Re-export Result type for consumers
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DispatchDestination =
  | 'meta_capi'
  | 'ga4_mp'
  | 'google_ads_conversion'
  | 'google_enhancement'
  | 'audience_sync';

export type DispatchStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'retrying'
  | 'failed'
  | 'skipped'
  | 'dead_letter';

export type AttemptStatus =
  | 'succeeded'
  | 'retryable_failure'
  | 'permanent_failure';

/**
 * Parameters used to derive the dispatch idempotency key.
 * INV-DISPATCH-002: all five fields participate in the hash.
 */
export type IdempotencyKeyParams = {
  workspace_id: string;
  event_id: string;
  destination: DispatchDestination;
  destination_resource_id: string;
  /** NULL-equivalent is empty string — BR-DISPATCH-001 */
  destination_subresource: string | null;
};

/**
 * Input for creating dispatch jobs from an ingested event.
 */
export type DispatchJobInput = {
  workspace_id: string;
  event_id: string;
  lead_id?: string | null;
  destination: DispatchDestination;
  destination_account_id: string;
  destination_resource_id: string;
  destination_subresource?: string | null;
  payload?: Record<string, unknown>;
  eligibility_reason?: string | null;
  max_attempts?: number;
};

/**
 * Optional payload capture — anexado pelo dispatcher para gravar em
 * `dispatch_attempts.{request,response}_payload_sanitized`. Quando o
 * dispatcher não popular, gravam-se `{}` (comportamento legacy).
 *
 * O dispatcher é responsável por sanitizar (BR-PRIVACY-001):
 *   - IPs em claro DEVEM ser redacted (helper `sanitizeDispatchPayload`).
 *   - Email/phone em claro nunca devem aparecer (já são hash em todos
 *     payloads para Meta/Google/GA4 por design das APIs).
 *
 * Use `unknown` para aceitar qualquer estrutura (Meta CAPI envelope,
 * GA4 MP, Google Ads request body, etc.) — o storage em jsonb tolera.
 */
export type DispatchPayloadCapture = {
  request?: unknown;
  response?: unknown;
};

/**
 * What a dispatcher function returns after attempting an external call.
 *
 * Cada variant pode opcionalmente trazer `request`/`response` para
 * observability via dispatch_attempts (T-DISPATCH-PAYLOAD-AUDIT, 2026-05-09).
 */
export type DispatchResult =
  | ({ ok: true } & DispatchPayloadCapture)
  | ({ ok: false; kind: 'rate_limit' } & DispatchPayloadCapture)
  | ({ ok: false; kind: 'server_error'; status: number } & DispatchPayloadCapture)
  | ({ ok: false; kind: 'permanent_failure'; code: string } & DispatchPayloadCapture)
  | ({ ok: false; kind: 'skip'; reason: string } & DispatchPayloadCapture);

/**
 * A dispatcher function — injected into processDispatchJob.
 * Receives the full job record and returns a DispatchResult.
 */
export type DispatchFn = (
  job: typeof dispatchJobs.$inferSelect,
) => Promise<DispatchResult>;

/**
 * Error types for processDispatchJob.
 */
export type ProcessingError =
  | { code: 'job_not_found' }
  | { code: 'already_processing' }
  | { code: 'invalid_state'; current_status: string };

/**
 * Error for requeueDeadLetter.
 */
export type RequeueError = {
  code: 'not_in_dead_letter';
  current_status: string;
};

// ---------------------------------------------------------------------------
// computeIdempotencyKey — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic dispatch idempotency key.
 *
 * BR-DISPATCH-001: idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
 * INV-DISPATCH-002: function is pure — same inputs always yield same output.
 * ADR-013: uses Web Crypto SubtleCrypto, available in CF Workers and modern Node.
 *
 * @param params - five canonical fields; destination_subresource=null is treated as ''
 * @returns hex-encoded SHA-256 digest
 */
export async function computeIdempotencyKey(
  params: IdempotencyKeyParams,
): Promise<string> {
  // BR-DISPATCH-001: canonical concatenation with '|' separator
  // destination_subresource null → '' (empty string) per spec
  const raw = [
    params.workspace_id,
    params.event_id,
    params.destination,
    params.destination_resource_id,
    params.destination_subresource ?? '',
  ].join('|');

  const encoded = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// computeReplayIdempotencyKey — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic idempotency key for a replay job.
 *
 * ADR-025: replay creates a new job child — must have a key distinct from the
 *   original to avoid violating INV-DISPATCH-001 (unique constraint).
 * BR-DISPATCH-001: key must remain globally unique.
 *
 * Formula: sha256(original_id|'replay'|replayed_at_iso)
 * Including the ISO timestamp ensures two replays of the same job at different
 * times each receive a unique key.
 *
 * @param originalJobId - UUID of the original dispatch_job being replayed
 * @param replayedAt    - timestamp of the replay request (use new Date().toISOString())
 * @returns hex-encoded SHA-256 digest
 */
export async function computeReplayIdempotencyKey(
  originalJobId: string,
  replayedAt: string,
): Promise<string> {
  // ADR-025: include 'replay' literal + original_id + timestamp to guarantee uniqueness
  const raw = [originalJobId, 'replay', replayedAt].join('|');

  const encoded = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// computeBackoff — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Computes retry delay in milliseconds with exponential backoff and ±20% jitter.
 *
 * INV-DISPATCH-007: delay = 2^attempt × (1 ± 0.2 random jitter) seconds.
 * BR-DISPATCH-003: backoff formula for rate_limit and server_error.
 *
 * @param attempt - zero-based attempt index (0 = first retry)
 * @param random  - injectable random source (defaults to Math.random); use in tests
 * @returns delay in milliseconds
 */
export function computeBackoff(
  attempt: number,
  random: () => number = Math.random,
): number {
  // BR-DISPATCH-003: base = 2^attempt seconds
  const baseSeconds = 2 ** attempt;

  // INV-DISPATCH-007: jitter = ±20% of base (random in [0,1) → scaled to [-0.2, +0.2))
  const jitter = (random() * 0.4 - 0.2) * baseSeconds;

  return Math.round((baseSeconds + jitter) * 1000);
}

// ---------------------------------------------------------------------------
// createDispatchJobs
// ---------------------------------------------------------------------------

/**
 * Creates dispatch_jobs records for each destination provided.
 * Uses ON CONFLICT (idempotency_key) DO NOTHING to ensure idempotence.
 *
 * BR-DISPATCH-001: idempotency_key derived by computeIdempotencyKey()
 * INV-DISPATCH-001: unique constraint on idempotency_key prevents duplicates
 *
 * @param inputs  - array of job descriptors (one per destination)
 * @param db      - Drizzle DB client (DI)
 * @returns array of created-or-existing DispatchJob records
 */
export async function createDispatchJobs(
  inputs: DispatchJobInput[],
  db: Db,
): Promise<(typeof dispatchJobs.$inferSelect)[]> {
  if (inputs.length === 0) return [];

  // BR-DISPATCH-001: compute idempotency key for every input
  const keyed = await Promise.all(
    inputs.map(async (input) => {
      const idempotencyKey = await computeIdempotencyKey({
        workspace_id: input.workspace_id,
        event_id: input.event_id,
        destination: input.destination,
        destination_resource_id: input.destination_resource_id,
        destination_subresource: input.destination_subresource ?? null,
      });
      return { input, idempotencyKey };
    }),
  );

  // Insert all jobs; conflicts silently skipped — idempotent by design
  // INV-DISPATCH-001: ON CONFLICT DO NOTHING relies on uq_dispatch_jobs_idempotency_key
  await db
    .insert(dispatchJobs)
    .values(
      keyed.map(({ input, idempotencyKey }) => ({
        workspaceId: input.workspace_id,
        eventId: input.event_id,
        eventWorkspaceId: input.workspace_id,
        leadId: input.lead_id ?? null,
        destination: input.destination,
        destinationAccountId: input.destination_account_id,
        destinationResourceId: input.destination_resource_id,
        destinationSubresource: input.destination_subresource ?? null,
        idempotencyKey,
        status: 'pending' as DispatchStatus,
        payload: jsonb(input.payload ?? {}),
        eligibilityReason: input.eligibility_reason ?? null,
        maxAttempts: input.max_attempts ?? 5,
        attemptCount: 0,
      })),
    )
    .onConflictDoNothing();

  // Fetch the canonical records (handles both newly created and pre-existing)
  const keys = keyed.map((k) => k.idempotencyKey);
  const rows = await db
    .select()
    .from(dispatchJobs)
    .where(inArray(dispatchJobs.idempotencyKey, keys));

  return rows;
}

// ---------------------------------------------------------------------------
// processDispatchJob
// ---------------------------------------------------------------------------

/**
 * Processes a single dispatch job:
 * 1. Acquires atomic lock (pending|retrying → processing).
 * 2. Calls dispatchFn — an injected function that contacts the external platform.
 * 3. Records the outcome in dispatch_attempts and updates job status.
 *
 * BR-DISPATCH-002: atomic UPDATE before calling external API (INV-DISPATCH-008)
 * BR-DISPATCH-003: backoff on retryable errors; dead_letter after max_attempts
 * BR-DISPATCH-004: skip requires skip_reason non-empty
 *
 * @param jobId      - UUID of the dispatch_job to process
 * @param dispatchFn - injected dispatcher (calls external platform)
 * @param db         - Drizzle DB client (DI)
 * @returns Result with the created DispatchAttempt on success, or ProcessingError
 */
export async function processDispatchJob(
  jobId: string,
  dispatchFn: DispatchFn,
  db: Db,
): Promise<Result<typeof dispatchAttempts.$inferSelect, ProcessingError>> {
  const now = new Date();

  // BR-DISPATCH-002: atomic lock — UPDATE status only when still in a processable state
  // INV-DISPATCH-008: at-least-once queue delivery cannot cause duplicate external calls
  const locked = await db
    .update(dispatchJobs)
    .set({ status: 'processing', updatedAt: now })
    .where(
      and(
        eq(dispatchJobs.id, jobId),
        inArray(dispatchJobs.status, ['pending', 'retrying']),
      ),
    )
    .returning();

  // BR-DISPATCH-002: 0 rows means another consumer already locked the job — abandon
  if (locked.length === 0) {
    // Could be already_processing or completed — treat as already_processing guard
    return { ok: false, error: { code: 'already_processing' } };
  }

  const job = locked[0];
  if (!job) {
    return { ok: false, error: { code: 'job_not_found' } };
  }

  const attemptNumber = job.attemptCount + 1;
  const attemptStartedAt = new Date();

  // Call the injected dispatcher — this is the only external I/O in this function
  let result: DispatchResult;
  try {
    result = await dispatchFn(job);
  } catch (err) {
    // Unexpected exception from dispatcher — treat as server_error (retryable)
    result = {
      ok: false,
      kind: 'server_error',
      status: 0,
    };
  }

  const attemptFinishedAt = new Date();

  // T-DISPATCH-PAYLOAD-AUDIT (2026-05-09): se o dispatcher anexou
  // request/response, sanitiza+grava; senão mantém {} (legacy).
  const payloads = buildAttemptPayloads(result);

  if (result.ok) {
    // --- SUCCESS path ---
    await db
      .update(dispatchJobs)
      .set({
        status: 'succeeded',
        attemptCount: attemptNumber,
        updatedAt: attemptFinishedAt,
      })
      .where(eq(dispatchJobs.id, jobId));

    const [attempt] = await db
      .insert(dispatchAttempts)
      .values({
        workspaceId: job.workspaceId,
        dispatchJobId: jobId,
        attemptNumber,
        status: 'succeeded' satisfies AttemptStatus,
        requestPayloadSanitized: payloads.request,
        responsePayloadSanitized: payloads.response,
        startedAt: attemptStartedAt,
        finishedAt: attemptFinishedAt,
      })
      .returning();

    if (!attempt) {
      return { ok: false, error: { code: 'job_not_found' } };
    }
    return { ok: true, value: attempt };
  }

  if (result.kind === 'skip') {
    // BR-DISPATCH-004: skip requires non-empty skip_reason (INV-DISPATCH-004)
    const skipReason = result.reason.trim();
    if (!skipReason) {
      // Fallback: never write skipped without reason — coerce to a safe value
      throw new Error(
        'BR-DISPATCH-004: dispatchFn returned skip with empty reason',
      );
    }

    await db
      .update(dispatchJobs)
      .set({
        status: 'skipped',
        skipReason,
        attemptCount: attemptNumber,
        updatedAt: attemptFinishedAt,
      })
      .where(eq(dispatchJobs.id, jobId));

    const [attempt] = await db
      .insert(dispatchAttempts)
      .values({
        workspaceId: job.workspaceId,
        dispatchJobId: jobId,
        attemptNumber,
        status: 'permanent_failure' satisfies AttemptStatus,
        requestPayloadSanitized: payloads.request,
        responsePayloadSanitized: payloads.response,
        errorCode: 'skipped',
        errorMessage: skipReason,
        startedAt: attemptStartedAt,
        finishedAt: attemptFinishedAt,
      })
      .returning();

    if (!attempt) {
      return { ok: false, error: { code: 'job_not_found' } };
    }
    return { ok: true, value: attempt };
  }

  if (result.kind === 'permanent_failure') {
    // --- PERMANENT FAILURE path (4xx) ---
    await db
      .update(dispatchJobs)
      .set({
        status: 'failed',
        attemptCount: attemptNumber,
        updatedAt: attemptFinishedAt,
      })
      .where(eq(dispatchJobs.id, jobId));

    const [attempt] = await db
      .insert(dispatchAttempts)
      .values({
        workspaceId: job.workspaceId,
        dispatchJobId: jobId,
        attemptNumber,
        status: 'permanent_failure' satisfies AttemptStatus,
        requestPayloadSanitized: payloads.request,
        responsePayloadSanitized: payloads.response,
        errorCode: result.code,
        startedAt: attemptStartedAt,
        finishedAt: attemptFinishedAt,
      })
      .returning();

    if (!attempt) {
      return { ok: false, error: { code: 'job_not_found' } };
    }
    return { ok: true, value: attempt };
  }

  // --- RETRYABLE path (rate_limit | server_error) ---
  // BR-DISPATCH-003: exponential backoff + jitter; dead_letter after max_attempts
  const newAttemptCount = attemptNumber;
  const maxAttempts = job.maxAttempts;

  if (newAttemptCount >= maxAttempts) {
    // Exhausted retries — move to dead_letter
    const dlqReason =
      result.kind === 'rate_limit'
        ? 'rate_limit'
        : `server_error:${result.status}`;

    await markDeadLetter(jobId, dlqReason, db, {
      workspaceId: job.workspaceId,
      attemptNumber: newAttemptCount,
      errorCode: result.kind,
      startedAt: attemptStartedAt,
      finishedAt: attemptFinishedAt,
      requestPayload: payloads.request,
      responsePayload: payloads.response,
    });

    const [attempt] = await db
      .select()
      .from(dispatchAttempts)
      .where(
        and(
          eq(dispatchAttempts.dispatchJobId, jobId),
          eq(dispatchAttempts.attemptNumber, newAttemptCount),
        ),
      );

    if (!attempt) {
      return { ok: false, error: { code: 'job_not_found' } };
    }
    return { ok: true, value: attempt };
  }

  // Still has attempts remaining — schedule retry
  // BR-DISPATCH-003: delay = 2^attempt × (1 ± 0.2 jitter) seconds
  const backoffMs = computeBackoff(newAttemptCount);
  const nextAttemptAt = new Date(attemptFinishedAt.getTime() + backoffMs);

  await db
    .update(dispatchJobs)
    .set({
      status: 'retrying',
      attemptCount: newAttemptCount,
      nextAttemptAt,
      updatedAt: attemptFinishedAt,
    })
    .where(eq(dispatchJobs.id, jobId));

  const [attempt] = await db
    .insert(dispatchAttempts)
    .values({
      workspaceId: job.workspaceId,
      dispatchJobId: jobId,
      attemptNumber: newAttemptCount,
      status: 'retryable_failure' satisfies AttemptStatus,
      requestPayloadSanitized: payloads.request,
      responsePayloadSanitized: payloads.response,
      errorCode: result.kind,
      errorMessage:
        result.kind === 'server_error' ? `HTTP ${result.status}` : result.kind,
      startedAt: attemptStartedAt,
      finishedAt: attemptFinishedAt,
    })
    .returning();

  if (!attempt) {
    return { ok: false, error: { code: 'job_not_found' } };
  }
  return { ok: true, value: attempt };
}

// ---------------------------------------------------------------------------
// markDeadLetter (internal + exported)
// ---------------------------------------------------------------------------

/**
 * Internal options passed from processDispatchJob to avoid a second DB round-trip.
 */
type DeadLetterAttemptOpts = {
  workspaceId: string;
  attemptNumber: number;
  errorCode?: string;
  startedAt: Date;
  finishedAt: Date;
  /**
   * Payloads pré-sanitizados (T-DISPATCH-PAYLOAD-AUDIT). Quando omitidos,
   * grava `{}` para preservar comportamento legacy.
   */
  requestPayload?: ReturnType<typeof jsonb>;
  responsePayload?: ReturnType<typeof jsonb>;
};

/**
 * Moves a dispatch job to dead_letter state and records a permanent_failure attempt.
 *
 * INV-DISPATCH-003: dead_letter jobs are NOT auto-reprocessed.
 * BR-DISPATCH-005: reprocessing requires explicit operator action via requeueDeadLetter.
 *
 * @param jobId       - UUID of the dispatch_job
 * @param reason      - human-readable reason for dead-lettering (no PII)
 * @param db          - Drizzle DB client (DI)
 * @param attemptOpts - optional — pre-filled attempt fields; if omitted, fetches job first
 */
export async function markDeadLetter(
  jobId: string,
  reason: string,
  db: Db,
  attemptOpts?: DeadLetterAttemptOpts,
): Promise<void> {
  const now = new Date();

  // INV-DISPATCH-003: set status=dead_letter, clear next_attempt_at
  await db
    .update(dispatchJobs)
    .set({
      status: 'dead_letter',
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(eq(dispatchJobs.id, jobId));

  if (attemptOpts) {
    // Fast path — called from processDispatchJob with all needed data
    await db.insert(dispatchAttempts).values({
      workspaceId: attemptOpts.workspaceId,
      dispatchJobId: jobId,
      attemptNumber: attemptOpts.attemptNumber,
      status: 'permanent_failure' satisfies AttemptStatus,
      requestPayloadSanitized: attemptOpts.requestPayload ?? jsonb({}),
      responsePayloadSanitized: attemptOpts.responsePayload ?? jsonb({}),
      errorCode: attemptOpts.errorCode ?? 'dead_letter',
      errorMessage: reason,
      startedAt: attemptOpts.startedAt,
      finishedAt: attemptOpts.finishedAt,
    });
  } else {
    // Standalone path — fetch job to get workspaceId and attemptCount
    const [job] = await db
      .select()
      .from(dispatchJobs)
      .where(eq(dispatchJobs.id, jobId));

    if (job) {
      await db.insert(dispatchAttempts).values({
        workspaceId: job.workspaceId,
        dispatchJobId: jobId,
        attemptNumber: job.attemptCount + 1,
        status: 'permanent_failure' satisfies AttemptStatus,
        requestPayloadSanitized: jsonb({}),
        responsePayloadSanitized: jsonb({}),
        errorCode: 'dead_letter',
        errorMessage: reason,
        startedAt: now,
        finishedAt: now,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// requeueDeadLetter
// ---------------------------------------------------------------------------

/**
 * Manually requeues a dead_letter job for re-processing.
 *
 * INV-DISPATCH-003: only dead_letter jobs can be requeued (not auto-reprocessed).
 * BR-DISPATCH-005: requires explicit operator action; resets attempt_count=0.
 *
 * @param jobId - UUID of the dispatch_job to requeue
 * @param db    - Drizzle DB client (DI)
 * @returns Result<void> — error if job is not in dead_letter state
 */
export async function requeueDeadLetter(
  jobId: string,
  db: Db,
): Promise<Result<void, RequeueError>> {
  // BR-DISPATCH-005: only dead_letter jobs can be manually requeued
  const [job] = await db
    .select({ id: dispatchJobs.id, status: dispatchJobs.status })
    .from(dispatchJobs)
    .where(eq(dispatchJobs.id, jobId));

  if (!job || job.status !== 'dead_letter') {
    return {
      ok: false,
      error: {
        code: 'not_in_dead_letter',
        current_status: job?.status ?? 'not_found',
      },
    };
  }

  // INV-DISPATCH-003: reset to pending with attempt_count=0 and next_attempt_at=now
  await db
    .update(dispatchJobs)
    .set({
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(dispatchJobs.id, jobId));

  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// createSkippedJob — BR-DISPATCH-004 helper
// ---------------------------------------------------------------------------

/**
 * Creates a dispatch_job directly in 'skipped' state.
 * Validates that skip_reason is non-empty before writing.
 *
 * BR-DISPATCH-004: status='skipped' MUST have non-empty skip_reason (INV-DISPATCH-004)
 *
 * @param input      - base job descriptor
 * @param skipReason - canonical skip reason (see BR-DISPATCH-004 for valid values)
 * @param db         - Drizzle DB client (DI)
 * @returns created DispatchJob or error if skip_reason is empty
 */
export async function createSkippedJob(
  input: DispatchJobInput,
  skipReason: string,
  db: Db,
): Promise<
  Result<
    typeof dispatchJobs.$inferSelect,
    { code: 'empty_skip_reason' } | { code: 'conflict_existing' }
  >
> {
  // BR-DISPATCH-004: skip_reason must be non-empty (INV-DISPATCH-004)
  if (!skipReason || skipReason.trim() === '') {
    return { ok: false, error: { code: 'empty_skip_reason' } };
  }

  const idempotencyKey = await computeIdempotencyKey({
    workspace_id: input.workspace_id,
    event_id: input.event_id,
    destination: input.destination,
    destination_resource_id: input.destination_resource_id,
    destination_subresource: input.destination_subresource ?? null,
  });

  const [created] = await db
    .insert(dispatchJobs)
    .values({
      workspaceId: input.workspace_id,
      eventId: input.event_id,
      eventWorkspaceId: input.workspace_id,
      leadId: input.lead_id ?? null,
      destination: input.destination,
      destinationAccountId: input.destination_account_id,
      destinationResourceId: input.destination_resource_id,
      destinationSubresource: input.destination_subresource ?? null,
      idempotencyKey,
      status: 'skipped' as DispatchStatus,
      skipReason: skipReason.trim(),
      payload: input.payload ?? {},
      eligibilityReason: input.eligibility_reason ?? null,
      maxAttempts: input.max_attempts ?? 5,
      attemptCount: 0,
    })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    return { ok: false, error: { code: 'conflict_existing' } };
  }

  return { ok: true, value: created };
}
