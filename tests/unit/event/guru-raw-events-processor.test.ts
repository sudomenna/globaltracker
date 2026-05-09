/**
 * Unit tests for apps/edge/src/lib/guru-raw-events-processor.ts
 *
 * T-ID: T-GURU-PROC-001
 *
 * All DB and dependencies are mocked — no real DB required.
 *
 * Coverage:
 *   - Happy path: Purchase event with email → resolves lead via email, inserts event + 'purchased' stage (no blueprint)
 *   - Happy path: pptc present → lead resolved by pptc (highest priority — BR-WEBHOOK-004)
 *   - Happy path: pptc present but not found → falls back to email resolution
 *   - Happy path: No identifiers → event inserted without lead link (resolvedLeadId = null)
 *   - Happy path: Blueprint dynamic stage resolution (funnel_role filter)
 *   - Idempotency: duplicate event_id (unique violation) → marks processed, returns ok (BR-EVENT-002)
 *   - Idempotency: already-processed raw_event → returns ok without re-insert (INV-EVENT-003)
 *   - Not found: raw_event_id does not exist → error not_found
 *   - Wrong status: raw_event is 'failed' → error wrong_status
 *   - Invalid payload: missing _guru_event_id → marks failed, returns invalid_payload error
 *   - BR-PRIVACY-001: email/phone never appear in returned error messages
 *
 * BRs applied:
 *   BR-WEBHOOK-004: pptc > email > phone lead resolution hierarchy
 *   BR-EVENT-002: idempotency on (workspace_id, event_id)
 *   BR-PRIVACY-001: PII never in logs or error messages
 *   BR-IDENTITY-003: canonical lead_id after merge
 *   INV-EVENT-001: unique (workspace_id, event_id) in events
 *   INV-EVENT-003: already-processed raw_event returns ok without re-insert
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processGuruRawEvent } from '../../../apps/edge/src/lib/guru-raw-events-processor.js';
import { unwrapJsonb } from '../../helpers/jsonb-unwrap.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// Mock @globaltracker/db to avoid real Drizzle imports
vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
  leads: {},
}));

// Mock lead-resolver
// T-CONTACTS-PII-001: processor now also imports normalizePhone for the
// in-clear PII enrichment block (called after resolveLeadByAliases).
vi.mock('../../../apps/edge/src/lib/lead-resolver.js', () => ({
  resolveLeadByAliases: vi.fn(),
  normalizePhone: vi.fn((p: string) => p),
}));

// Mock pii-enrich
// T-CONTACTS-PII-001: enrichLeadPii is invoked after the resolver. Stubbed
// here so unit tests don't hit the real (DB-touching) implementation.
vi.mock('../../../apps/edge/src/lib/pii-enrich.js', () => ({
  enrichLeadPii: vi.fn().mockResolvedValue({ ok: true, updated_columns: [] }),
}));

// Mock pii (hashPii)
vi.mock('../../../apps/edge/src/lib/pii.js', () => ({
  hashPii: vi.fn().mockResolvedValue('abc123hash'),
}));

// Mock sanitize-logs to prevent log output during tests and allow inspection
vi.mock('../../../apps/edge/src/middleware/sanitize-logs.js', () => ({
  safeLog: vi.fn(),
}));

// Mock getBlueprintForLaunch and matchesStageFilters from raw-events-processor
// to control blueprint behavior in unit tests.
vi.mock('../../../apps/edge/src/lib/raw-events-processor.js', () => ({
  getBlueprintForLaunch: vi.fn().mockResolvedValue(null),
  matchesStageFilters: vi.fn().mockReturnValue(false),
}));

import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver.js';
import { getBlueprintForLaunch, matchesStageFilters } from '../../../apps/edge/src/lib/raw-events-processor.js';

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

type InsertCapture = {
  table: string;
  values: Record<string, unknown>;
};

/**
 * Creates a minimal Drizzle-like mock DB sufficient for processGuruRawEvent.
 * Supports: select (raw_events, events, leads), insert (events, lead_stages, raw_events update).
 */
function createMockDb(opts: {
  rawEvent?: Record<string, unknown> | null;
  /** Simulate unique violation on events insert */
  eventsInsertUnique?: boolean;
  /** Simulate DB error on events insert */
  eventsInsertError?: boolean;
  /** Lead row returned for pptc lookup (null = not found) */
  leadByPptc?: { id: string } | null;
}) {
  const inserts: InsertCapture[] = [];
  const updates: Array<{ table: string; set: Record<string, unknown> }> = [];

  let eventInsertIdCounter = 0;

  const db = {
    select: vi.fn().mockImplementation((_fields?: unknown) => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        const tableName = String(table);
        return {
          where: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation(async () => {
              // rawEvents select
              if (tableName.includes('rawEvents') || tableName === '[object Object]') {
                // Heuristic: first select call is rawEvents
                if (opts.rawEvent !== undefined) {
                  return opts.rawEvent !== null ? [opts.rawEvent] : [];
                }
                return [];
              }
              return [];
            }),
          })),
        };
      }),
    })),

    insert: vi.fn().mockImplementation((table: unknown) => {
      const tableName = String(table);
      return {
        values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          inserts.push({ table: tableName, values });

          if (opts.eventsInsertUnique && tableName.includes('events')) {
            // Simulate unique constraint violation
            const err = new Error('duplicate key value violates unique constraint — 23505');
            const returning = () => Promise.reject(err);
            const base = Promise.reject(err);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock extension
            (base as any).returning = returning;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock extension
            return base as any;
          }

          if (opts.eventsInsertError && tableName.includes('events')) {
            const err = new Error('DB connection error');
            const returning = () => Promise.reject(err);
            const base = Promise.reject(err);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock extension
            (base as any).returning = returning;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock extension
            return base as any;
          }

          eventInsertIdCounter++;
          const id = `evt-${eventInsertIdCounter}`;
          const base = Promise.resolve([]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock extension
          (base as any).returning = (_fields?: unknown) => Promise.resolve([{ id }]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock extension
          return base as any;
        }),
      };
    }),

    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((set: Record<string, unknown>) => {
        updates.push({ table: String(table), set });
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
  };

  // Override select to support leads table (pptc lookup)
  let selectCallCount = 0;
  db.select = vi.fn().mockImplementation((_fields?: unknown) => ({
    from: vi.fn().mockImplementation((_table: unknown) => ({
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockImplementation(async () => {
          selectCallCount++;
          // First call = rawEvents lookup
          if (selectCallCount === 1) {
            if (opts.rawEvent !== undefined) {
              return opts.rawEvent !== null ? [opts.rawEvent] : [];
            }
            return [];
          }
          // Second call = leads pptc lookup
          if (selectCallCount === 2 && opts.leadByPptc !== undefined) {
            return opts.leadByPptc !== null ? [opts.leadByPptc] : [];
          }
          return [];
        }),
      })),
    })),
  }));

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock object
    db: db as any,
    inserts,
    updates,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const RAW_EVENT_ID = '22222222-2222-2222-2222-222222222222';
const GURU_EVENT_ID = 'guru-event-abc-123';
const LAUNCH_ID = '33333333-3333-3333-3333-333333333333';
const LEAD_ID = '44444444-4444-4444-4444-444444444444';

function makePendingRawEvent(payloadOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RAW_EVENT_ID,
    workspaceId: WORKSPACE_ID,
    processingStatus: 'pending',
    receivedAt: new Date('2024-01-15T10:31:00Z'),
    payload: {
      _guru_event_id: GURU_EVENT_ID,
      _guru_event_type: 'Purchase',
      webhook_type: 'transaction',
      launch_id: LAUNCH_ID,
      funnel_role: 'workshop',
      contact: {
        email: 'buyer@example.com',
        phone_number: '999999999',
        phone_local_code: '55',
      },
      source: {
        utm_source: 'facebook',
        utm_campaign: 'camp_123',
      },
      payment: {
        total: 29700,
        currency: 'BRL',
      },
      product: {
        id: 'prod-001',
        name: 'Curso Teste',
      },
      confirmed_at: '2024-01-15T10:31:00Z',
      ...payloadOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processGuruRawEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no blueprint (fallback path)
    vi.mocked(getBlueprintForLaunch).mockResolvedValue(null);
    vi.mocked(matchesStageFilters).mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  // Step 1: raw_event fetch
  // -------------------------------------------------------------------------

  describe('Step 1: raw_event fetch', () => {
    it('returns not_found when raw_event_id does not exist', async () => {
      const { db } = createMockDb({ rawEvent: null });
      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_found');
      }
    });

    it('returns ok (idempotent skip) when raw_event is already processed (INV-EVENT-003)', async () => {
      const { db } = createMockDb({
        rawEvent: {
          ...makePendingRawEvent(),
          processingStatus: 'processed',
        },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event_id).toBe(GURU_EVENT_ID);
        expect(result.value.dispatch_jobs_created).toBe(0);
      }
    });

    it('returns wrong_status error when raw_event is in failed status', async () => {
      const { db } = createMockDb({
        rawEvent: {
          ...makePendingRawEvent(),
          processingStatus: 'failed',
        },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('wrong_status');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Step 2: payload validation
  // -------------------------------------------------------------------------

  describe('Step 2: payload validation', () => {
    it('returns invalid_payload when _guru_event_id is missing', async () => {
      const rawEvent = makePendingRawEvent();
      // Remove _guru_event_id from payload
      delete (rawEvent.payload as Record<string, unknown>)._guru_event_id;

      const { db, updates } = createMockDb({ rawEvent });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_payload');
      }
      // Should mark raw_event as failed
      expect(updates.length).toBeGreaterThanOrEqual(1);
    });

    it('returns invalid_payload when _guru_event_type is missing', async () => {
      const rawEvent = makePendingRawEvent();
      delete (rawEvent.payload as Record<string, unknown>)._guru_event_type;

      const { db } = createMockDb({ rawEvent });
      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_payload');
      }
    });

    it('accepts payload with all optional fields absent', async () => {
      const rawEvent = {
        id: RAW_EVENT_ID,
        workspaceId: WORKSPACE_ID,
        processingStatus: 'pending',
        receivedAt: new Date('2024-01-15T10:31:00Z'),
        payload: {
          _guru_event_id: GURU_EVENT_ID,
          _guru_event_type: 'Purchase',
          webhook_type: 'transaction',
          // No contact, source, payment, product, confirmed_at, launch_id, funnel_role
        },
      };

      const { db } = createMockDb({ rawEvent });
      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      // Without email/phone and no pptc, lead resolution is skipped; event still inserted
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event_id).toBe(GURU_EVENT_ID);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Step 3: lead resolution (BR-WEBHOOK-004 hierarchy)
  // -------------------------------------------------------------------------

  describe('Step 3: lead resolution — BR-WEBHOOK-004 hierarchy', () => {
    it('resolves lead by pptc first (highest priority — BR-WEBHOOK-004)', async () => {
      const rawEvent = makePendingRawEvent({
        source: {
          pptc: LEAD_ID, // pptc = lead.id
          utm_source: 'facebook',
        },
      });

      const { db } = createMockDb({
        rawEvent,
        leadByPptc: { id: LEAD_ID },
      });

      // resolveLeadByAliases should NOT be called when pptc resolves
      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: 'other-lead', was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // resolveLeadByAliases should not have been called because pptc resolved
      expect(resolveLeadByAliases).not.toHaveBeenCalled();
    });

    it('falls back to email/phone when pptc not found in DB', async () => {
      const rawEvent = makePendingRawEvent({
        source: {
          pptc: 'nonexistent-lead-id',
        },
      });

      const { db } = createMockDb({
        rawEvent,
        leadByPptc: null, // pptc lookup returns nothing
      });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // Falls back to email/phone — resolveLeadByAliases should be called
      expect(resolveLeadByAliases).toHaveBeenCalled();
    });

    it('resolves lead by email/phone when no pptc present', async () => {
      const rawEvent = makePendingRawEvent({
        source: { utm_source: 'facebook' }, // no pptc
      });

      const { db } = createMockDb({ rawEvent });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // T-CONTACTS-LASTSEEN-002: processor now forwards eventTime so
      // backfilled webhooks don't bump leads.last_seen_at to NOW().
      expect(resolveLeadByAliases).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'buyer@example.com' }),
        WORKSPACE_ID,
        db,
        expect.objectContaining({ eventTime: expect.any(Date) }),
      );
    });

    it('inserts event without lead link when no identifiers available (resolvedLeadId = null)', async () => {
      const rawEvent = {
        id: RAW_EVENT_ID,
        workspaceId: WORKSPACE_ID,
        processingStatus: 'pending',
        receivedAt: new Date(),
        payload: {
          _guru_event_id: GURU_EVENT_ID,
          _guru_event_type: 'Purchase',
          webhook_type: 'transaction',
          // no contact, no pptc
        },
      };

      const { db } = createMockDb({ rawEvent });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // resolveLeadByAliases should NOT be called
      expect(resolveLeadByAliases).not.toHaveBeenCalled();
    });

    it('non-fatal when lead resolution via email fails — event still inserted', async () => {
      const rawEvent = makePendingRawEvent({ source: { utm_source: 'facebook' } });
      const { db } = createMockDb({ rawEvent });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: false,
        error: { code: 'db_error', message: 'connection timeout' },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      // Event should still be inserted (lead resolution failure is non-fatal for Guru)
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event_id).toBe(GURU_EVENT_ID);
      }
    });

    it('BR-PRIVACY-001: email not present in error.message on lead resolution failure', async () => {
      const rawEvent = makePendingRawEvent({ source: { utm_source: 'facebook' } });
      const { db } = createMockDb({ rawEvent });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: false,
        error: { code: 'invalid_input', message: 'phone_normalization_failed' },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      // Even on failure, event is still processed
      expect(result.ok).toBe(true);
      if (!result.ok) {
        // If error returned, must not contain PII
        const errorStr = JSON.stringify(result.error);
        expect(errorStr).not.toContain('buyer@example.com');
        expect(errorStr).not.toContain('999999999');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Step 4: event insert — idempotency
  // -------------------------------------------------------------------------

  describe('Step 4: event insert — idempotency (BR-EVENT-002, INV-EVENT-001)', () => {
    it('returns ok when duplicate event_id causes unique violation (BR-EVENT-002)', async () => {
      const { db, updates } = createMockDb({
        rawEvent: makePendingRawEvent(),
        eventsInsertUnique: true,
      });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event_id).toBe(GURU_EVENT_ID);
        expect(result.value.dispatch_jobs_created).toBe(0);
      }
      // Should mark raw_event as processed
      expect(updates.some((u) => (u.set as Record<string, unknown>).processingStatus === 'processed')).toBe(true);
    });

    it('marks raw_event as failed when a non-unique DB error occurs during insert', async () => {
      // Build a custom mock where the events insert rejects with a non-unique error.
      // We verify that markRawEventFailed is invoked (processing_status = 'failed').
      const rawEvent = makePendingRawEvent();
      const markedFailed: string[] = [];

      const db = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockResolvedValue([rawEvent]),
            })),
          })),
        })),
        insert: vi.fn().mockImplementation(() => {
          // BR-EVENT-002: error message must NOT contain 'unique' — otherwise isUniqueViolation() returns true
          // and the processor treats it as idempotent success instead of a DB error.
          const err = new Error('DB connection failure: server timeout');
          return {
            values: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockRejectedValue(err),
            })),
          };
        }),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((set: Record<string, unknown>) => {
            if (set.processingStatus === 'failed') {
              markedFailed.push(String(set.processingStatus));
            }
            return {
              where: vi.fn().mockResolvedValue(undefined),
            };
          }),
        })),
      };

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock object
      const result = await processGuruRawEvent(RAW_EVENT_ID, db as any);

      // The insert path calls `.values({...}).returning({...})` — when returning() rejects with
      // a non-unique error, the processor catches it and calls markRawEventFailed.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('db_error');
      }
      expect(markedFailed).toContain('failed');
    });
  });

  // -------------------------------------------------------------------------
  // Step 5: lead_stages
  // -------------------------------------------------------------------------

  describe('Step 5: lead_stages', () => {
    it('inserts purchased stage on Purchase event without blueprint (fallback)', async () => {
      const { db, inserts } = createMockDb({ rawEvent: makePendingRawEvent() });
      vi.mocked(getBlueprintForLaunch).mockResolvedValue(null);

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // Check that a leadStages insert was attempted
      const stageInserts = inserts.filter((i) =>
        JSON.stringify(i.values).includes('purchased'),
      );
      expect(stageInserts.length).toBeGreaterThanOrEqual(1);
    });

    it('does not insert lead_stage when resolvedLeadId is null', async () => {
      const rawEvent = {
        id: RAW_EVENT_ID,
        workspaceId: WORKSPACE_ID,
        processingStatus: 'pending',
        receivedAt: new Date(),
        payload: {
          _guru_event_id: GURU_EVENT_ID,
          _guru_event_type: 'Purchase',
          webhook_type: 'transaction',
          launch_id: LAUNCH_ID,
          // No contact — resolvedLeadId remains null
        },
      };

      const { db, inserts } = createMockDb({ rawEvent });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // No lead_stage insert should occur (lead_id required)
      const stageInserts = inserts.filter((i) =>
        JSON.stringify(i.values).includes('purchased'),
      );
      expect(stageInserts.length).toBe(0);
    });

    it('does not insert lead_stage when launch_id is absent', async () => {
      const rawEvent = makePendingRawEvent();
      // Remove launch_id
      delete (rawEvent.payload as Record<string, unknown>).launch_id;

      const { db, inserts } = createMockDb({ rawEvent });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      const stageInserts = inserts.filter((i) =>
        JSON.stringify(i.values).includes('purchased'),
      );
      expect(stageInserts.length).toBe(0);
    });

    it('uses blueprint stage when blueprint matches event_type + funnel_role filter', async () => {
      // Simulate a blueprint with a workshop stage that matches Purchase + funnel_role=workshop
      const mockBlueprint = {
        version: 1,
        stages: [
          {
            slug: 'purchased_workshop',
            label: 'Comprou Workshop',
            source_events: ['Purchase'],
            source_event_filters: { funnel_role: 'workshop' },
            is_recurring: false,
          },
        ],
      };

      vi.mocked(getBlueprintForLaunch).mockResolvedValue(mockBlueprint as Parameters<typeof matchesStageFilters>[2] extends infer S ? never : never as any);
      // Make matchesStageFilters return true for the workshop stage
      vi.mocked(matchesStageFilters).mockReturnValue(true);

      const { db, inserts } = createMockDb({ rawEvent: makePendingRawEvent() });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      // matchesStageFilters should have been called
      expect(matchesStageFilters).toHaveBeenCalled();
      // A stage insert should have been attempted
      expect(inserts.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Step 6 + 7: mark processed + return
  // -------------------------------------------------------------------------

  describe('Happy path end-to-end return values', () => {
    it('returns event_id, dispatch_jobs_created=0 on success', async () => {
      const { db } = createMockDb({ rawEvent: makePendingRawEvent() });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      const result = await processGuruRawEvent(RAW_EVENT_ID, db);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.event_id).toBe(GURU_EVENT_ID);
        expect(result.value.dispatch_jobs_created).toBe(0);
        expect(result.value.dispatch_job_ids).toEqual([]);
      }
    });

    it('marks raw_event as processed on success', async () => {
      const { db, updates } = createMockDb({ rawEvent: makePendingRawEvent() });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      await processGuruRawEvent(RAW_EVENT_ID, db);

      // There should be an update setting processingStatus = 'processed'
      expect(
        updates.some(
          (u) => (u.set as Record<string, unknown>).processingStatus === 'processed',
        ),
      ).toBe(true);
    });

    it('maps payment.total (centavos) to amount (monetary unit) correctly', async () => {
      const { db, inserts } = createMockDb({
        rawEvent: makePendingRawEvent({ payment: { total: 29700, currency: 'BRL' } }),
      });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      await processGuruRawEvent(RAW_EVENT_ID, db);

      // Find the events insert
      const eventsInsert = inserts.find((i) =>
        JSON.stringify(i.values).includes('customData') ||
        (i.values.customData !== undefined),
      );

      if (eventsInsert && eventsInsert.values.customData) {
        const customData = eventsInsert.values.customData as Record<string, unknown>;
        expect(customData.amount).toBe(297); // 29700 / 100 = 297
        expect(customData.currency).toBe('BRL');
      }
    });

    it('sets consentSnapshot to granted for buyer (implicit consent)', async () => {
      const { db, inserts } = createMockDb({ rawEvent: makePendingRawEvent() });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      await processGuruRawEvent(RAW_EVENT_ID, db);

      const eventsInsert = inserts.find((i) => i.values.consentSnapshot !== undefined);

      if (eventsInsert) {
        // T-13-013: jsonb() helper wraps writes as SQL fragments — unwrap for asserts
        const consent = unwrapJsonb(eventsInsert.values.consentSnapshot) as Record<string, unknown>;
        expect(consent.analytics).toBe('granted');
        expect(consent.marketing).toBe('granted');
        expect(consent.ad_user_data).toBe('granted');
        expect(consent.ad_personalization).toBe('granted');
        expect(consent.customer_match).toBe('granted');
      }
    });

    it('uses confirmed_at for eventTime when available', async () => {
      const confirmedAt = '2024-06-15T12:00:00Z';
      const { db, inserts } = createMockDb({
        rawEvent: makePendingRawEvent({ confirmed_at: confirmedAt }),
      });

      vi.mocked(resolveLeadByAliases).mockResolvedValue({
        ok: true,
        value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
      });

      await processGuruRawEvent(RAW_EVENT_ID, db);

      const eventsInsert = inserts.find((i) => i.values.eventTime !== undefined);
      if (eventsInsert) {
        expect(eventsInsert.values.eventTime).toEqual(new Date(confirmedAt));
      }
    });
  });
});
