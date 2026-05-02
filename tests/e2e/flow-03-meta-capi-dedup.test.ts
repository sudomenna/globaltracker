/**
 * E2E flow tests — FLOW-03: Enviar Lead para Meta CAPI com deduplicação
 *
 * T-ID: T-3-009
 * Spec: docs/60-flows/03-send-lead-to-meta-capi-with-dedup.md
 *
 * Tests the dispatch lifecycle for a Meta CAPI job end-to-end using
 * in-process domain functions against a stateful mock DB.
 * No real Postgres or Meta CAPI network call is required.
 *
 * Scenarios covered:
 *   TC-03-01: Happy path — job created, processed once, status=succeeded, 1 attempt row
 *   TC-03-02: Idempotency — two createDispatchJobs calls with same key produce 1 row (INV-DISPATCH-001)
 *   TC-03-03: Atomic lock — second processDispatchJob call returns already_processing (INV-DISPATCH-008)
 *   TC-03-04: Consent denied — dispatchFn returns skip → job=skipped, skip_reason populated (BR-DISPATCH-004)
 *   TC-03-05: Rate-limit 429 — dispatchFn returns rate_limit → job=retrying, attempt=retryable_failure
 *   TC-03-06: Permanent failure 400 invalid_pixel — dispatchFn returns permanent_failure → job=failed
 *
 * BRs applied (cited inline):
 *   BR-DISPATCH-001: idempotency_key = sha256(workspace_id|event_id|destination|resource_id|subresource)
 *   BR-DISPATCH-002: atomic lock (pending|retrying → processing) before calling external API
 *   BR-DISPATCH-003: backoff + dead_letter after max_attempts
 *   BR-DISPATCH-004: skip_reason required when status='skipped'
 *   BR-DISPATCH-005: dead_letter not auto-reprocessed
 *   INV-DISPATCH-001: idempotency_key unique — ON CONFLICT DO NOTHING
 *   INV-DISPATCH-002: computeIdempotencyKey is pure — same inputs → same output
 *   INV-DISPATCH-003: dead_letter jobs NOT auto-reprocessed
 *   INV-DISPATCH-004: skipped job has non-empty skip_reason
 *   INV-DISPATCH-008: atomic lock prevents duplicate external calls
 */

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchFn } from '../../apps/edge/src/lib/dispatch';
import {
  computeIdempotencyKey,
  createDispatchJobs,
  processDispatchJob,
} from '../../apps/edge/src/lib/dispatch';

// ---------------------------------------------------------------------------
// Constants (deterministic — no Math.random() without seed; no new Date() without mock)
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-f03-0000-0000-0000-000000000001';
const EVENT_ID = crypto.randomUUID(); // fixed per test run; not random per test
const LEAD_ID = 'lead-f03-0000-0000-0000-aaaaaaaaaaaa';
const PIXEL_ID = 'pixel-123456789';
const DESTINATION = 'meta_capi' as const;

// ---------------------------------------------------------------------------
// Stateful in-memory mock DB
//
// Mimics Drizzle's query API surface for dispatch_jobs + dispatch_attempts.
// Enforces the unique constraint on idempotency_key (INV-DISPATCH-001).
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  workspaceId: string;
  eventId: string;
  eventWorkspaceId: string;
  leadId: string | null;
  destination: string;
  destinationAccountId: string;
  destinationResourceId: string;
  destinationSubresource: string | null;
  idempotencyKey: string;
  status: string;
  skipReason: string | null;
  payload: Record<string, unknown>;
  eligibilityReason: string | null;
  maxAttempts: number;
  attemptCount: number;
  nextAttemptAt: Date | null;
  scheduledAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface AttemptRow {
  id: string;
  workspaceId: string;
  dispatchJobId: string;
  attemptNumber: number;
  status: string;
  requestPayloadSanitized: Record<string, unknown>;
  responsePayloadSanitized: Record<string, unknown>;
  responseStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
}

function makeDispatchDb() {
  const jobsTable = new Map<string, JobRow>();
  const attemptTable: AttemptRow[] = [];

  let jobCounter = 0;
  let attemptCounter = 0;

  // Build a row from insert values; assign defaults matching schema.
  function buildJobRow(values: Record<string, unknown>): JobRow {
    const now = new Date('2026-05-02T10:00:00Z');
    return {
      id: `job-${++jobCounter}`,
      workspaceId: values.workspaceId as string,
      eventId: values.eventId as string,
      eventWorkspaceId: values.eventWorkspaceId as string,
      leadId: (values.leadId as string | null | undefined) ?? null,
      destination: values.destination as string,
      destinationAccountId: values.destinationAccountId as string,
      destinationResourceId: values.destinationResourceId as string,
      destinationSubresource:
        (values.destinationSubresource as string | null | undefined) ?? null,
      idempotencyKey: values.idempotencyKey as string,
      status: (values.status as string | undefined) ?? 'pending',
      skipReason: (values.skipReason as string | null | undefined) ?? null,
      payload: (values.payload as Record<string, unknown> | undefined) ?? {},
      eligibilityReason:
        (values.eligibilityReason as string | null | undefined) ?? null,
      maxAttempts: (values.maxAttempts as number | undefined) ?? 5,
      attemptCount: (values.attemptCount as number | undefined) ?? 0,
      nextAttemptAt: (values.nextAttemptAt as Date | null | undefined) ?? null,
      scheduledAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Builds an attempt row from insert values.
  function buildAttemptRow(values: Record<string, unknown>): AttemptRow {
    return {
      id: `attempt-${++attemptCounter}`,
      workspaceId: values.workspaceId as string,
      dispatchJobId: values.dispatchJobId as string,
      attemptNumber: values.attemptNumber as number,
      status: values.status as string,
      requestPayloadSanitized:
        (values.requestPayloadSanitized as Record<string, unknown>) ?? {},
      responsePayloadSanitized:
        (values.responsePayloadSanitized as Record<string, unknown>) ?? {},
      responseStatus:
        (values.responseStatus as number | null | undefined) ?? null,
      errorCode: (values.errorCode as string | null | undefined) ?? null,
      errorMessage: (values.errorMessage as string | null | undefined) ?? null,
      startedAt: values.startedAt as Date,
      finishedAt: (values.finishedAt as Date | null | undefined) ?? null,
      createdAt: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Drizzle-style mock db object
  // ---------------------------------------------------------------------------

  const db = {
    // ---- dispatch_jobs.insert ----
    insert: vi.fn((table: unknown) => {
      // We detect table by checking what fields the values have — same technique
      // used in the existing stateful mock DB in the codebase.
      return {
        values: vi.fn(
          (rowsOrRow: Record<string, unknown> | Record<string, unknown>[]) => {
            // Normalize to array (createDispatchJobs inserts array; processDispatchJob inserts single)
            const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];

            const isJobInsert = typeof rows[0]?.idempotencyKey === 'string';

            return {
              onConflictDoNothing: vi.fn(() => {
                if (isJobInsert) {
                  // INV-DISPATCH-001: unique on idempotency_key — skip conflict rows
                  for (const row of rows) {
                    const key = row.idempotencyKey as string;
                    if (!jobsTable.has(key)) {
                      const built = buildJobRow(row);
                      jobsTable.set(key, built);
                    }
                  }
                }
                return Promise.resolve([]);
              }),
              returning: vi.fn(() => {
                if (!isJobInsert) {
                  // dispatch_attempts insert (no onConflictDoNothing)
                  const row = rows[0];
                  if (!row) return Promise.resolve([]);
                  const built = buildAttemptRow(row);
                  attemptTable.push(built);
                  return Promise.resolve([built]);
                }
                // Should not be called for jobs (we use onConflictDoNothing)
                return Promise.resolve([]);
              }),
            };
          },
        ),
      };
    }),

    // ---- dispatch_jobs.select / dispatch_attempts.select ----
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          return Promise.resolve(
            attemptTable.filter(() => true), // simplified — return all; callers filter in app code
          );
        }),
      })),
    })),

    // ---- dispatch_jobs.update ----
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((setValues: Record<string, unknown>) => ({
        where: vi.fn((_condition: unknown) => {
          // Apply update to any job that is in a processable state
          // (pending|retrying → processing).
          // We simulate the returning[] array that processDispatchJob relies on.
          const updated: JobRow[] = [];

          for (const job of jobsTable.values()) {
            const currentStatus = job.status;
            const targetStatuses = ['pending', 'retrying'];

            // processDispatchJob: UPDATE WHERE status IN ('pending', 'retrying')
            if (
              targetStatuses.includes(currentStatus) ||
              // For non-locking updates (after dispatch result) we unconditionally apply
              (setValues.status !== 'processing' && job.status === 'processing')
            ) {
              // Only the first matching job per call (simulates single-row UPDATE)
              if (updated.length === 0 || setValues.status !== 'processing') {
                Object.assign(job, setValues);
                updated.push({ ...job });
              }
            }
          }

          return { returning: vi.fn(() => Promise.resolve(updated)) };
        }),
      })),
    })),
  };

  return { db, jobsTable, attemptTable };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FLOW-03: Meta CAPI dispatch lifecycle', () => {
  // Unique per test run; created deterministically by beforeEach seeding.
  let eventId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use a fixed event_id per test; suites re-create fresh DB instances.
    eventId = crypto.randomUUID();
  });

  // --------------------------------------------------------------------------
  // TC-03-01: Happy path — dispatch succeeds on first attempt
  // --------------------------------------------------------------------------

  describe('TC-03-01: happy path — job created, processed, status=succeeded, 1 attempt row', () => {
    it('BR-DISPATCH-001: createDispatchJobs derives deterministic idempotency_key', async () => {
      const key = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: PIXEL_ID,
        destination_subresource: PIXEL_ID,
      });

      // INV-DISPATCH-002: pure — same inputs always yield same output
      const key2 = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: PIXEL_ID,
        destination_subresource: PIXEL_ID,
      });

      expect(key).toBe(key2);
      // hex SHA-256 = 64 chars
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('processDispatchJob succeeds → dispatch_job.status=succeeded + 1 dispatch_attempt row', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();

      // Seed a pending job directly into the table
      const idempotencyKey = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: PIXEL_ID,
        destination_subresource: PIXEL_ID,
      });

      const seededJob = {
        id: 'job-seed-01',
        workspaceId: WORKSPACE_ID,
        eventId: eventId,
        eventWorkspaceId: WORKSPACE_ID,
        leadId: LEAD_ID,
        destination: DESTINATION,
        destinationAccountId: 'meta-act-001',
        destinationResourceId: PIXEL_ID,
        destinationSubresource: PIXEL_ID,
        idempotencyKey,
        status: 'pending',
        skipReason: null,
        payload: {},
        eligibilityReason: null,
        maxAttempts: 5,
        attemptCount: 0,
        nextAttemptAt: null,
        scheduledAt: new Date('2026-05-02T10:00:00Z'),
        createdAt: new Date('2026-05-02T10:00:00Z'),
        updatedAt: new Date('2026-05-02T10:00:00Z'),
      };
      jobsTable.set(idempotencyKey, seededJob);

      // Mock dispatchFn — simulates sendToMetaCapi returning success
      const mockDispatchFn: DispatchFn = vi
        .fn()
        .mockResolvedValue({ ok: true });

      const result = await processDispatchJob(
        seededJob.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // dispatch_attempt row created (INV-DISPATCH-005)
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.status).toBe('succeeded');
      expect(attemptTable[0]?.attemptNumber).toBe(1);

      // dispatch_job updated to succeeded
      const jobRow = seededJob; // reference is mutated by mock db.update
      expect(jobRow.status).toBe('succeeded');

      // dispatchFn called exactly once (INV-DISPATCH-008)
      expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // TC-03-02: Idempotency — same idempotency_key produces exactly 1 job row
  // --------------------------------------------------------------------------

  describe('TC-03-02: idempotency — duplicate job insert is silently ignored (INV-DISPATCH-001)', () => {
    it('createDispatchJobs called twice with same params → exactly 1 row in dispatch_jobs', async () => {
      const { db, jobsTable } = makeDispatchDb();

      const input = {
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_account_id: 'meta-act-001',
        destination_resource_id: PIXEL_ID,
        destination_subresource: PIXEL_ID,
        lead_id: LEAD_ID,
      };

      // First call — inserts 1 row
      await createDispatchJobs(
        [input],
        db as unknown as Parameters<typeof createDispatchJobs>[1],
      );

      const sizeAfterFirst = jobsTable.size;
      expect(sizeAfterFirst).toBe(1);

      // Second call — same idempotency_key → ON CONFLICT DO NOTHING (INV-DISPATCH-001)
      await createDispatchJobs(
        [input],
        db as unknown as Parameters<typeof createDispatchJobs>[1],
      );

      // INV-DISPATCH-001: still exactly 1 row
      expect(jobsTable.size).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // TC-03-03: Atomic lock — second processDispatchJob call returns already_processing
  // --------------------------------------------------------------------------

  describe('TC-03-03: atomic lock prevents duplicate dispatch (INV-DISPATCH-008, BR-DISPATCH-002)', () => {
    it('second call for job already in processing state returns already_processing error', async () => {
      const { db, jobsTable } = makeDispatchDb();

      const idempotencyKey = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: PIXEL_ID,
        destination_subresource: null,
      });

      // Seed a job that has already been claimed (status=processing)
      const seededJob = {
        id: 'job-locked-01',
        workspaceId: WORKSPACE_ID,
        eventId: eventId,
        eventWorkspaceId: WORKSPACE_ID,
        leadId: null,
        destination: DESTINATION,
        destinationAccountId: 'meta-act-001',
        destinationResourceId: PIXEL_ID,
        destinationSubresource: null,
        idempotencyKey,
        status: 'processing', // already locked
        skipReason: null,
        payload: {},
        eligibilityReason: null,
        maxAttempts: 5,
        attemptCount: 0,
        nextAttemptAt: null,
        scheduledAt: new Date('2026-05-02T10:00:00Z'),
        createdAt: new Date('2026-05-02T10:00:00Z'),
        updatedAt: new Date('2026-05-02T10:00:00Z'),
      };
      jobsTable.set(idempotencyKey, seededJob);

      const mockDispatchFn: DispatchFn = vi
        .fn()
        .mockResolvedValue({ ok: true });

      // BR-DISPATCH-002: UPDATE WHERE status IN ('pending', 'retrying') → 0 rows
      const result = await processDispatchJob(
        seededJob.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      // INV-DISPATCH-008: already_processing returned — no external call
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('already_processing');

      // dispatchFn must NOT have been called (no duplicate external call)
      expect(mockDispatchFn).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // TC-03-04: Consent denied — job transitions to skipped (BR-DISPATCH-004)
  // --------------------------------------------------------------------------

  describe('TC-03-04: consent denied → job=skipped, skip_reason populated (BR-DISPATCH-004)', () => {
    it('dispatchFn returning skip → status=skipped, INV-DISPATCH-004 enforced', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();

      const idempotencyKey = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: PIXEL_ID,
        destination_subresource: PIXEL_ID,
      });

      const seededJob = {
        id: 'job-consent-01',
        workspaceId: WORKSPACE_ID,
        eventId: eventId,
        eventWorkspaceId: WORKSPACE_ID,
        leadId: LEAD_ID,
        destination: DESTINATION,
        destinationAccountId: 'meta-act-001',
        destinationResourceId: PIXEL_ID,
        destinationSubresource: PIXEL_ID,
        idempotencyKey,
        status: 'pending',
        skipReason: null,
        payload: {},
        eligibilityReason: null,
        maxAttempts: 5,
        attemptCount: 0,
        nextAttemptAt: null,
        scheduledAt: new Date('2026-05-02T10:00:00Z'),
        createdAt: new Date('2026-05-02T10:00:00Z'),
        updatedAt: new Date('2026-05-02T10:00:00Z'),
      };
      jobsTable.set(idempotencyKey, seededJob);

      // BR-DISPATCH-004: dispatchFn returns skip with mandatory reason
      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'skip',
        reason: 'consent_denied:ad_user_data',
      });

      const result = await processDispatchJob(
        seededJob.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // INV-DISPATCH-004: skipped job has non-empty skip_reason
      const job = seededJob;
      expect(job.status).toBe('skipped');
      expect(job.skipReason).toBe('consent_denied:ad_user_data');

      // An attempt row is created even for skipped jobs (for audit)
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.errorCode).toBe('skipped');
    });
  });

  // --------------------------------------------------------------------------
  // TC-03-05: Rate-limit 429 — job transitions to retrying (BR-DISPATCH-003)
  // --------------------------------------------------------------------------

  describe('TC-03-05: rate-limit → job=retrying, attempt=retryable_failure (BR-DISPATCH-003)', () => {
    it('dispatchFn returning rate_limit → status=retrying + attempt row with retryable_failure', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();

      const idempotencyKey = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: PIXEL_ID,
        destination_subresource: null,
      });

      const seededJob = {
        id: 'job-retry-01',
        workspaceId: WORKSPACE_ID,
        eventId: eventId,
        eventWorkspaceId: WORKSPACE_ID,
        leadId: null,
        destination: DESTINATION,
        destinationAccountId: 'meta-act-001',
        destinationResourceId: PIXEL_ID,
        destinationSubresource: null,
        idempotencyKey,
        status: 'pending',
        skipReason: null,
        payload: {},
        eligibilityReason: null,
        maxAttempts: 5,
        attemptCount: 0,
        nextAttemptAt: null,
        scheduledAt: new Date('2026-05-02T10:00:00Z'),
        createdAt: new Date('2026-05-02T10:00:00Z'),
        updatedAt: new Date('2026-05-02T10:00:00Z'),
      };
      jobsTable.set(idempotencyKey, seededJob);

      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'rate_limit',
      });

      const result = await processDispatchJob(
        seededJob.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // BR-DISPATCH-003: status transitions to retrying
      expect(seededJob.status).toBe('retrying');

      // Attempt row with retryable_failure
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.status).toBe('retryable_failure');
      expect(attemptTable[0]?.errorCode).toBe('rate_limit');
    });
  });

  // --------------------------------------------------------------------------
  // TC-03-06: Permanent failure 400 invalid_pixel — job=failed (BR-DISPATCH-003)
  // --------------------------------------------------------------------------

  describe('TC-03-06: permanent failure → job=failed, no retry (BR-DISPATCH-003)', () => {
    it('dispatchFn returning permanent_failure:invalid_pixel_id → status=failed immediately', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();

      const idempotencyKey = await computeIdempotencyKey({
        workspace_id: WORKSPACE_ID,
        event_id: eventId,
        destination: DESTINATION,
        destination_resource_id: 'invalid-pixel',
        destination_subresource: 'invalid-pixel',
      });

      const seededJob = {
        id: 'job-perm-01',
        workspaceId: WORKSPACE_ID,
        eventId: eventId,
        eventWorkspaceId: WORKSPACE_ID,
        leadId: null,
        destination: DESTINATION,
        destinationAccountId: 'meta-act-001',
        destinationResourceId: 'invalid-pixel',
        destinationSubresource: 'invalid-pixel',
        idempotencyKey,
        status: 'pending',
        skipReason: null,
        payload: {},
        eligibilityReason: null,
        maxAttempts: 5,
        attemptCount: 0,
        nextAttemptAt: null,
        scheduledAt: new Date('2026-05-02T10:00:00Z'),
        createdAt: new Date('2026-05-02T10:00:00Z'),
        updatedAt: new Date('2026-05-02T10:00:00Z'),
      };
      jobsTable.set(idempotencyKey, seededJob);

      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'permanent_failure',
        code: 'invalid_pixel_id',
      });

      const result = await processDispatchJob(
        seededJob.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // BR-DISPATCH-003: permanent failure → status=failed (no retry)
      expect(seededJob.status).toBe('failed');

      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.status).toBe('permanent_failure');
      expect(attemptTable[0]?.errorCode).toBe('invalid_pixel_id');
    });
  });
});

// ---------------------------------------------------------------------------
// computeIdempotencyKey purity — INV-DISPATCH-002
// ---------------------------------------------------------------------------

describe('computeIdempotencyKey — INV-DISPATCH-002: pure function', () => {
  it('same inputs with null subresource always return same key', async () => {
    const params = {
      workspace_id: WORKSPACE_ID,
      event_id: EVENT_ID,
      destination: DESTINATION,
      destination_resource_id: PIXEL_ID,
      destination_subresource: null,
    };

    const k1 = await computeIdempotencyKey(params);
    const k2 = await computeIdempotencyKey(params);
    expect(k1).toBe(k2);
  });

  it('null and empty-string subresource produce the same key (BR-DISPATCH-001 null→empty spec)', async () => {
    const withNull = await computeIdempotencyKey({
      workspace_id: WORKSPACE_ID,
      event_id: EVENT_ID,
      destination: DESTINATION,
      destination_resource_id: PIXEL_ID,
      destination_subresource: null,
    });
    const withEmpty = await computeIdempotencyKey({
      workspace_id: WORKSPACE_ID,
      event_id: EVENT_ID,
      destination: DESTINATION,
      destination_resource_id: PIXEL_ID,
      destination_subresource: '',
    });
    expect(withNull).toBe(withEmpty);
  });

  it('different event_ids produce different keys', async () => {
    const k1 = await computeIdempotencyKey({
      workspace_id: WORKSPACE_ID,
      event_id: 'event-a',
      destination: DESTINATION,
      destination_resource_id: PIXEL_ID,
      destination_subresource: null,
    });
    const k2 = await computeIdempotencyKey({
      workspace_id: WORKSPACE_ID,
      event_id: 'event-b',
      destination: DESTINATION,
      destination_resource_id: PIXEL_ID,
      destination_subresource: null,
    });
    expect(k1).not.toBe(k2);
  });
});
