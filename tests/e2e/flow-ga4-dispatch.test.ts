/**
 * E2E flow tests — GA4 Measurement Protocol dispatch lifecycle
 *
 * T-ID: T-4-004 (GA4 MP dispatcher)
 * Spec: apps/edge/src/dispatchers/ga4-mp/
 *
 * Tests the full GA4 dispatch cycle using the same stateful mock DB pattern
 * established in flow-03-meta-capi-dedup.test.ts, adapted for GA4-specific
 * skip reasons and the client_id resolution rules.
 *
 * Scenarios covered:
 *   TC-GA4-01: Happy path — processDispatchJob with sendToGa4 returning 204 →
 *              job.status=succeeded, 1 dispatch_attempt row
 *   TC-GA4-02: Skip — dispatchFn returns skip:no_client_id →
 *              job.status=skipped, skip_reason='no_client_id' (BR-DISPATCH-004)
 *   TC-GA4-03: Skip — dispatchFn returns skip:consent_denied:analytics →
 *              job.status=skipped (BR-CONSENT-003)
 *   TC-GA4-04: Skip — dispatchFn returns skip:integration_not_configured →
 *              job.status=skipped
 *   TC-GA4-05: Server error 500 → job.status=retrying, attempt=retryable_failure
 *              (BR-DISPATCH-003)
 *   TC-GA4-06: Permanent failure 400 → job.status=failed (BR-DISPATCH-003)
 *   TC-GA4-07: resolveClientId from fvid → minted client_id matches GA1.1.* format
 *   TC-GA4-08: resolveClientId with explicit client_id_ga4 → returned verbatim
 *   TC-GA4-09: resolveClientId with no user_data → returns null (no_client_id path)
 *   TC-GA4-10: mapEventToGa4Payload → Purchase maps to 'purchase' GA4 name
 *   TC-GA4-11: mapEventToGa4Payload → Subscribe (no GA4 equivalent) returns null
 *   TC-GA4-12: checkEligibility — no measurementId → integration_not_configured
 *   TC-GA4-13: checkEligibility — analytics consent=denied → consent_denied:analytics
 *   TC-GA4-14: checkEligibility — granted consent + valid client_id → eligible
 *
 * BRs applied (cited inline):
 *   BR-DISPATCH-001: idempotency_key derivation
 *   BR-DISPATCH-002: atomic lock before external call (INV-DISPATCH-008)
 *   BR-DISPATCH-003: retry vs permanent failure classification
 *   BR-DISPATCH-004: skip_reason mandatory (INV-DISPATCH-004)
 *   BR-CONSENT-003: analytics consent required for GA4 MP
 *   BR-PRIVACY-001: no PII in fixtures
 */

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchFn } from '../../apps/edge/src/lib/dispatch.js';
import {
  computeIdempotencyKey,
  processDispatchJob,
} from '../../apps/edge/src/lib/dispatch.js';

import { resolveClientId } from '../../apps/edge/src/dispatchers/ga4-mp/client-id-resolver.js';
import { checkEligibility } from '../../apps/edge/src/dispatchers/ga4-mp/eligibility.js';
import { mapEventToGa4Payload } from '../../apps/edge/src/dispatchers/ga4-mp/mapper.js';

// ---------------------------------------------------------------------------
// Constants — deterministic
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-f-ga4-0000-0000-0000-000000000001';
const MEASUREMENT_ID = 'G-TESTMEASURE1';
const DESTINATION = 'ga4_mp' as const;

// ---------------------------------------------------------------------------
// Stateful in-memory mock DB — reused from FLOW-03 pattern
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

  function buildAttemptRow(values: Record<string, unknown>): AttemptRow {
    return {
      id: `attempt-ga4-${++attemptCounter}`,
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
      createdAt: new Date('2026-05-02T12:00:00Z'),
    };
  }

  const db = {
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn(
        (rowsOrRow: Record<string, unknown> | Record<string, unknown>[]) => {
          const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const isJobInsert = typeof rows[0]?.idempotencyKey === 'string';

          return {
            onConflictDoNothing: vi.fn(() => {
              if (isJobInsert) {
                for (const row of rows) {
                  const key = row.idempotencyKey as string;
                  if (!jobsTable.has(key)) {
                    const now = new Date('2026-05-02T12:00:00Z');
                    const built: JobRow = {
                      id: `job-ga4-${++jobCounter}`,
                      workspaceId: row.workspaceId as string,
                      eventId: row.eventId as string,
                      eventWorkspaceId: row.eventWorkspaceId as string,
                      leadId: (row.leadId as string | null | undefined) ?? null,
                      destination: row.destination as string,
                      destinationAccountId: row.destinationAccountId as string,
                      destinationResourceId:
                        row.destinationResourceId as string,
                      destinationSubresource:
                        (row.destinationSubresource as
                          | string
                          | null
                          | undefined) ?? null,
                      idempotencyKey: row.idempotencyKey as string,
                      status: (row.status as string | undefined) ?? 'pending',
                      skipReason:
                        (row.skipReason as string | null | undefined) ?? null,
                      payload:
                        (row.payload as Record<string, unknown> | undefined) ??
                        {},
                      eligibilityReason:
                        (row.eligibilityReason as string | null | undefined) ??
                        null,
                      maxAttempts: (row.maxAttempts as number | undefined) ?? 5,
                      attemptCount:
                        (row.attemptCount as number | undefined) ?? 0,
                      nextAttemptAt:
                        (row.nextAttemptAt as Date | null | undefined) ?? null,
                      scheduledAt: now,
                      createdAt: now,
                      updatedAt: now,
                    };
                    jobsTable.set(key, built);
                  }
                }
              }
              return Promise.resolve([]);
            }),
            returning: vi.fn(() => {
              if (!isJobInsert) {
                const row = rows[0];
                if (!row) return Promise.resolve([]);
                const built = buildAttemptRow(row);
                attemptTable.push(built);
                return Promise.resolve([built]);
              }
              return Promise.resolve([]);
            }),
          };
        },
      ),
    })),

    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((_condition: unknown) =>
          Promise.resolve([...attemptTable]),
        ),
      })),
    })),

    update: vi.fn((_table: unknown) => ({
      set: vi.fn((setValues: Record<string, unknown>) => ({
        where: vi.fn((_condition: unknown) => {
          const updated: JobRow[] = [];

          for (const job of jobsTable.values()) {
            const currentStatus = job.status;
            const targetStatuses = ['pending', 'retrying'];

            if (
              targetStatuses.includes(currentStatus) ||
              (setValues.status !== 'processing' && job.status === 'processing')
            ) {
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
// Helper: build a seeded pending job for GA4 destination
// ---------------------------------------------------------------------------

async function seedPendingJob(
  jobsTable: Map<string, JobRow>,
  overrides: Partial<JobRow> = {},
): Promise<JobRow> {
  const eventId = crypto.randomUUID();
  const idempotencyKey = await computeIdempotencyKey({
    workspace_id: WORKSPACE_ID,
    event_id: eventId,
    destination: DESTINATION,
    destination_resource_id: MEASUREMENT_ID,
    destination_subresource: MEASUREMENT_ID,
  });

  const now = new Date('2026-05-02T12:00:00Z');
  const job: JobRow = {
    id: `job-ga4-seed-${jobsTable.size + 1}`,
    workspaceId: WORKSPACE_ID,
    eventId,
    eventWorkspaceId: WORKSPACE_ID,
    leadId: null,
    destination: DESTINATION,
    destinationAccountId: 'ga4-account-001',
    destinationResourceId: MEASUREMENT_ID,
    destinationSubresource: MEASUREMENT_ID,
    idempotencyKey,
    status: 'pending',
    skipReason: null,
    payload: {},
    eligibilityReason: null,
    maxAttempts: 5,
    attemptCount: 0,
    nextAttemptAt: null,
    scheduledAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  jobsTable.set(idempotencyKey, job);
  return job;
}

// ---------------------------------------------------------------------------
// Suite: processDispatchJob lifecycle for GA4
// ---------------------------------------------------------------------------

describe('FLOW-GA4: GA4 MP dispatch lifecycle via processDispatchJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // TC-GA4-01: Happy path — sendToGa4 returns 204 → succeeded
  // --------------------------------------------------------------------------

  describe('TC-GA4-01: happy path — sendToGa4 returns 204 → job.status=succeeded, 1 attempt row', () => {
    it('processDispatchJob with ok=true dispatchFn → succeeded + 1 succeeded attempt', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();
      const job = await seedPendingJob(jobsTable);

      // dispatchFn simulates sendToGa4 returning success (204 → ok:true)
      const mockDispatchFn: DispatchFn = vi
        .fn()
        .mockResolvedValue({ ok: true });

      const result = await processDispatchJob(
        job.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(result.ok).toBe(true);
      expect(mockDispatchFn).toHaveBeenCalledTimes(1);

      // dispatch_attempt row created
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.status).toBe('succeeded');
      expect(attemptTable[0]?.attemptNumber).toBe(1);

      // job status updated
      expect(job.status).toBe('succeeded');
    });
  });

  // --------------------------------------------------------------------------
  // TC-GA4-02: Skip — no_client_id (OQ-012)
  // --------------------------------------------------------------------------

  describe('TC-GA4-02: skip — no_client_id → job.status=skipped (BR-DISPATCH-004)', () => {
    it('dispatchFn returning skip:no_client_id → skipped with non-empty skip_reason', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();
      const job = await seedPendingJob(jobsTable);

      // BR-DISPATCH-004: dispatchFn returns skip with mandatory reason
      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'skip',
        reason: 'no_client_id',
      });

      const result = await processDispatchJob(
        job.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(result.ok).toBe(true);

      // INV-DISPATCH-004: skip_reason must be non-empty
      expect(job.status).toBe('skipped');
      expect(job.skipReason).toBe('no_client_id');

      // Attempt row created for audit trail
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.errorCode).toBe('skipped');
    });
  });

  // --------------------------------------------------------------------------
  // TC-GA4-03: Skip — consent_denied:analytics (BR-CONSENT-003)
  // --------------------------------------------------------------------------

  describe('TC-GA4-03: skip — consent_denied:analytics → job.status=skipped (BR-CONSENT-003)', () => {
    it('dispatchFn returning consent skip → skipped with analytics reason', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();
      const job = await seedPendingJob(jobsTable);

      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'skip',
        reason: 'consent_denied:analytics',
      });

      await processDispatchJob(
        job.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(job.status).toBe('skipped');
      // BR-CONSENT-003: analytics consent skip reason preserved
      expect(job.skipReason).toBe('consent_denied:analytics');
      expect(attemptTable).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // TC-GA4-04: Skip — integration_not_configured
  // --------------------------------------------------------------------------

  describe('TC-GA4-04: skip — integration_not_configured → job.status=skipped', () => {
    it('dispatchFn returning integration_not_configured skip → skipped', async () => {
      const { db, jobsTable } = makeDispatchDb();
      const job = await seedPendingJob(jobsTable);

      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'skip',
        reason: 'integration_not_configured',
      });

      await processDispatchJob(
        job.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(job.status).toBe('skipped');
      expect(job.skipReason).toBe('integration_not_configured');
    });
  });

  // --------------------------------------------------------------------------
  // TC-GA4-05: Server error 500 → retrying (BR-DISPATCH-003)
  // --------------------------------------------------------------------------

  describe('TC-GA4-05: server_error 500 → job.status=retrying, attempt=retryable_failure (BR-DISPATCH-003)', () => {
    it('dispatchFn returning server_error → retrying with retryable_failure attempt', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();
      const job = await seedPendingJob(jobsTable);

      // GA4 500 from sendToGa4 → { ok: false, kind: 'server_error', status: 500 }
      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'server_error',
        status: 500,
      });

      await processDispatchJob(
        job.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      // BR-DISPATCH-003: server_error → retrying (not exceeded maxAttempts)
      expect(job.status).toBe('retrying');
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.status).toBe('retryable_failure');
      expect(attemptTable[0]?.errorCode).toBe('server_error');
    });
  });

  // --------------------------------------------------------------------------
  // TC-GA4-06: Permanent failure 400 → failed (BR-DISPATCH-003)
  // --------------------------------------------------------------------------

  describe('TC-GA4-06: permanent_failure (4xx) → job.status=failed, no retry (BR-DISPATCH-003)', () => {
    it('dispatchFn returning permanent_failure:http_400 → failed immediately', async () => {
      const { db, jobsTable, attemptTable } = makeDispatchDb();
      const job = await seedPendingJob(jobsTable);

      // GA4 400 from sendToGa4 → { ok: false, kind: 'permanent_failure', code: 'http_400' }
      const mockDispatchFn: DispatchFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'permanent_failure',
        code: 'http_400',
      });

      await processDispatchJob(
        job.id,
        mockDispatchFn,
        db as unknown as Parameters<typeof processDispatchJob>[2],
      );

      expect(job.status).toBe('failed');
      expect(attemptTable).toHaveLength(1);
      expect(attemptTable[0]?.status).toBe('permanent_failure');
      expect(attemptTable[0]?.errorCode).toBe('http_400');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite: resolveClientId — pure function, no I/O
// ---------------------------------------------------------------------------

describe('resolveClientId — GA4 client_id derivation rules', () => {
  // TC-GA4-07: client_id_ga4 explicit → returned verbatim
  it('TC-GA4-08: explicit client_id_ga4 returned verbatim (priority 1)', () => {
    const clientId = resolveClientId({
      client_id_ga4: 'GA1.1.123456789.987654321',
      fvid: 'fvid-should-be-ignored',
    });
    expect(clientId).toBe('GA1.1.123456789.987654321');
  });

  // TC-GA4-07: fvid present, no client_id_ga4 → minted in GA1.1.* format
  it('TC-GA4-07: fvid minted client_id has GA1.1.* prefix and correct segment lengths', () => {
    // fvid with 18+ chars: segments are [0..8] and [8..18]
    const fvid = 'abcdefgh1234567890';
    const clientId = resolveClientId({ fvid });

    expect(clientId).not.toBeNull();
    // Format: GA1.1.<8chars>.<10chars>
    expect(clientId).toMatch(/^GA1\.1\.[a-zA-Z0-9]{8}\.[a-zA-Z0-9]{10}$/);
    // Verify exact segments
    expect(clientId).toBe('GA1.1.abcdefgh.1234567890');
  });

  it('TC-GA4-07b: short fvid is right-padded with zeros before segmentation', () => {
    const fvid = 'abc'; // shorter than 18 chars
    const clientId = resolveClientId({ fvid });

    // padded: "abc000000000000000" → segment1='abc00000', segment2='0000000000'
    expect(clientId).toBe('GA1.1.abc00000.0000000000');
  });

  // TC-GA4-09: no user_data → null
  it('TC-GA4-09: no user_data → resolveClientId returns null (no_client_id path)', () => {
    expect(resolveClientId(null)).toBeNull();
    expect(resolveClientId(undefined)).toBeNull();
    expect(resolveClientId({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite: checkEligibility — pure function, no I/O
// ---------------------------------------------------------------------------

describe('checkEligibility — GA4 pre-dispatch eligibility rules', () => {
  // TC-GA4-12: no measurementId → integration_not_configured
  it('TC-GA4-12: no measurementId → integration_not_configured', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'granted' },
        user_data: { client_id_ga4: 'GA1.1.123.456' },
      },
      null,
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('integration_not_configured');
    }
  });

  it('TC-GA4-12b: empty measurementId → integration_not_configured', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'granted' },
        user_data: { client_id_ga4: 'GA1.1.123.456' },
      },
      { measurementId: '', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('integration_not_configured');
    }
  });

  // TC-GA4-13: analytics consent=denied → consent_denied:analytics (BR-CONSENT-003)
  it('TC-GA4-13: analytics consent=denied → consent_denied:analytics (BR-CONSENT-003)', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'denied' },
        user_data: { client_id_ga4: 'GA1.1.123.456' },
      },
      { measurementId: 'G-TEST123', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('consent_denied:analytics');
    }
  });

  it('TC-GA4-13b: analytics consent=unknown → consent_denied:analytics', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'unknown' },
        user_data: { client_id_ga4: 'GA1.1.123.456' },
      },
      { measurementId: 'G-TEST123', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('consent_denied:analytics');
    }
  });

  it('analytics consent absent (no snapshot) → consent_denied:analytics', () => {
    const result = checkEligibility(
      { user_data: { client_id_ga4: 'GA1.1.123.456' } },
      { measurementId: 'G-TEST123', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('consent_denied:analytics');
    }
  });

  it('no client_id derivable → no_client_id', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'granted' },
        user_data: {}, // neither client_id_ga4 nor fvid
      },
      { measurementId: 'G-TEST123', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('no_client_id');
    }
  });

  // TC-GA4-14: all checks pass → eligible
  it('TC-GA4-14: granted consent + valid client_id_ga4 + measurementId → eligible', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'granted' },
        user_data: { client_id_ga4: 'GA1.1.123456789.987654321' },
      },
      { measurementId: 'G-TEST123', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(true);
  });

  it('TC-GA4-14b: granted consent + fvid (no _ga cookie) → eligible via minted client_id', () => {
    const result = checkEligibility(
      {
        consent_snapshot: { analytics: 'granted' },
        user_data: { fvid: 'abcdefgh1234567890' }, // 18 chars → mintable
      },
      { measurementId: 'G-TEST123', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: mapEventToGa4Payload — pure function
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload — GA4 event name translation and payload shape', () => {
  const BASE_EVENT = {
    event_id: 'evt-ga4-test-001',
    event_name: 'Purchase',
    event_time: new Date('2026-05-01T14:00:00Z'),
    lead_id: 'lead-ga4-001',
    workspace_id: WORKSPACE_ID,
    user_data: { client_id_ga4: 'GA1.1.111111111.2222222222' },
    consent_snapshot: {
      analytics: 'granted' as const,
      ad_user_data: 'granted' as const,
      ad_personalization: 'denied' as const,
    },
  };

  // TC-GA4-10: Purchase → 'purchase'
  it('TC-GA4-10: Purchase internal event maps to GA4 purchase event name', () => {
    const payload = mapEventToGa4Payload(BASE_EVENT, null);
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.name).toBe('purchase');
  });

  // TC-GA4-11: Subscribe → null (no GA4 equivalent)
  it('TC-GA4-11: Subscribe has no GA4 equivalent → mapEventToGa4Payload returns null', () => {
    const payload = mapEventToGa4Payload(
      { ...BASE_EVENT, event_name: 'Subscribe' },
      null,
    );
    expect(payload).toBeNull();
  });

  it('Lead maps to generate_lead', () => {
    const payload = mapEventToGa4Payload(
      { ...BASE_EVENT, event_name: 'Lead' },
      null,
    );
    expect(payload?.events[0]?.name).toBe('generate_lead');
  });

  it('InitiateCheckout maps to begin_checkout', () => {
    const payload = mapEventToGa4Payload(
      { ...BASE_EVENT, event_name: 'InitiateCheckout' },
      null,
    );
    expect(payload?.events[0]?.name).toBe('begin_checkout');
  });

  it('timestamp_micros is populated from event_time Date', () => {
    const payload = mapEventToGa4Payload(BASE_EVENT, null);
    // 2026-05-01T14:00:00Z → ms = 1777644000000 → seconds = 1777644000 → micros = 1777644000000000
    expect(payload?.timestamp_micros).toBe(1777644000000000);
  });

  it('client_id set from user_data.client_id_ga4', () => {
    const payload = mapEventToGa4Payload(BASE_EVENT, null);
    expect(payload?.client_id).toBe('GA1.1.111111111.2222222222');
  });

  it('user_id populated from lead.public_id when provided', () => {
    const payload = mapEventToGa4Payload(BASE_EVENT, {
      public_id: 'lead-public-abc123',
    });
    expect(payload?.user_id).toBe('lead-public-abc123');
  });

  it('consent signal forwarded with ad_user_data and ad_personalization (BR-CONSENT-003)', () => {
    const payload = mapEventToGa4Payload(BASE_EVENT, null);
    expect(payload?.consent).toEqual({
      ad_user_data: 'granted',
      ad_personalization: 'denied',
    });
  });

  it('custom_data.order_id maps to transaction_id in GA4 params', () => {
    const payload = mapEventToGa4Payload(
      {
        ...BASE_EVENT,
        custom_data: { order_id: 'ORD-9876', value: 99.9, currency: 'BRL' },
      },
      null,
    );
    expect(payload?.events[0]?.params?.transaction_id).toBe('ORD-9876');
    expect(payload?.events[0]?.params?.value).toBe(99.9);
    expect(payload?.events[0]?.params?.currency).toBe('BRL');
  });

  it('unknown custom event name passes through verbatim (not in no-equivalent list)', () => {
    const payload = mapEventToGa4Payload(
      { ...BASE_EVENT, event_name: 'CustomVideoPlay' },
      null,
    );
    // Unknown names are passed as custom events (not in the null-mapping list)
    expect(payload).not.toBeNull();
    expect(payload?.events[0]?.name).toBe('CustomVideoPlay');
  });
});
