/**
 * Integration test — processor-creates-dispatch-jobs.test.ts
 *
 * Tests the full processRawEvent() pipeline end-to-end against an ephemeral
 * in-memory mock DB (no real Postgres required).
 *
 * Sprint 2 scope: verifies that after processing:
 *   - events row is created with correct fields
 *   - lead_stages row is created when applicable
 *   - raw_event.processing_status = 'processed'
 *   - dispatch_jobs_created = 0 (OQ-011 — integration config not yet available)
 *
 * INVs exercised:
 *   INV-EVENT-001: (workspace_id, event_id) unique → idempotent on duplicate
 *   INV-EVENT-003: already-processed raw_event → ok without re-insert
 *   INV-EVENT-006: consent_snapshot populated on all events
 *   INV-EVENT-007: lead_id resolved for Lead events
 *
 * BRs exercised:
 *   BR-EVENT-002: idempotency by (workspace_id, event_id)
 *   BR-PRIVACY-001: processing_error never contains PII
 *
 * Note: This test uses a full state-tracking mock DB (not Postgres) that mimics
 * Drizzle's query interface. A real DB integration test is gated on OQ-011
 * resolution (Sprint 3 integration config) and is marked as TODO below.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processRawEvent } from '../../../apps/edge/src/lib/raw-events-processor';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
  workspaces: { id: 'id', config: 'config' },
}));

vi.mock('../../../apps/edge/src/lib/lead-resolver', () => ({
  resolveLeadByAliases: vi.fn(),
}));

vi.mock('../../../apps/edge/src/lib/attribution', () => ({
  recordTouches: vi.fn().mockResolvedValue({
    ok: true,
    value: { first_created: true, last_updated: true },
  }),
}));

vi.mock('../../../apps/edge/src/lib/pii', () => ({
  hashPii: vi.fn().mockResolvedValue('hash_value'),
}));

import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// State-tracking mock DB
//
// Simulates a relational DB in memory:
//   eventsTable: rows inserted by the processor
//   leadStagesTable: rows inserted by the processor
//   rawEventsTable: raw_event rows with mutable status
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  workspaceId: string;
  eventId: string;
  eventName: string;
  eventSource: string;
  schemaVersion: number;
  leadId?: string;
  launchId?: string;
  pageId?: string;
  eventTime: Date;
  receivedAt: Date;
  attribution: Record<string, unknown>;
  userData: Record<string, unknown>;
  customData: Record<string, unknown>;
  consentSnapshot: Record<string, unknown>;
  requestContext: Record<string, unknown>;
  processingStatus: string;
  createdAt: Date;
}

interface LeadStageRow {
  id: string;
  workspaceId: string;
  leadId: string;
  launchId: string;
  stage: string;
  isRecurring: boolean;
  sourceEventId: string;
  ts: Date;
}

interface RawEventRow {
  id: string;
  workspaceId: string;
  pageId: string | null;
  processingStatus: string;
  processingError: string | null;
  processedAt: Date | null;
  receivedAt: Date;
  headersSanitized: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function makeStatefulDb() {
  const eventsTable: EventRow[] = [];
  const leadStagesTable: LeadStageRow[] = [];
  const rawEventsTable: Map<string, RawEventRow> = new Map();

  let eventUuidCounter = 0;
  let stageUuidCounter = 0;

  function addRawEvent(row: RawEventRow) {
    rawEventsTable.set(row.id, row);
  }

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn((limit: number) => {
            // Return raw_events by id (select is only used for raw_events lookup)
            const rows = [...rawEventsTable.values()].slice(0, limit);
            return Promise.resolve(rows);
          }),
        })),
      })),
    })),

    insert: vi.fn((table: unknown) => {
      // Table discrimination by object identity (mocked objects from @globaltracker/db)
      // We check which insert it is by call order — simpler in unit/integration tests
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          // If values has eventId (string) = events table
          if (typeof values.eventId === 'string') {
            // Check for unique violation
            const existing = eventsTable.find(
              (e) =>
                e.workspaceId === values.workspaceId &&
                e.eventId === values.eventId,
            );
            if (existing) {
              return {
                returning: vi.fn(() =>
                  Promise.reject(
                    new Error(
                      'duplicate key value violates unique constraint (23505)',
                    ),
                  ),
                ),
              };
            }

            const id = `evt-uuid-${++eventUuidCounter}`;
            const row: EventRow = {
              id,
              workspaceId: values.workspaceId as string,
              eventId: values.eventId as string,
              eventName: values.eventName as string,
              eventSource: values.eventSource as string,
              schemaVersion: (values.schemaVersion as number) ?? 1,
              leadId: values.leadId as string | undefined,
              launchId: values.launchId as string | undefined,
              pageId: values.pageId as string | undefined,
              eventTime: values.eventTime as Date,
              receivedAt: values.receivedAt as Date,
              attribution:
                (values.attribution as Record<string, unknown>) ?? {},
              userData: (values.userData as Record<string, unknown>) ?? {},
              customData: (values.customData as Record<string, unknown>) ?? {},
              consentSnapshot:
                (values.consentSnapshot as Record<string, unknown>) ?? {},
              requestContext:
                (values.requestContext as Record<string, unknown>) ?? {},
              processingStatus:
                (values.processingStatus as string) ?? 'accepted',
              createdAt: new Date(),
            };
            eventsTable.push(row);
            return { returning: vi.fn(() => Promise.resolve([{ id }])) };
          }

          // Otherwise = lead_stages table
          if (
            typeof values.leadId === 'string' &&
            typeof values.stage === 'string'
          ) {
            // Check for unique violation (INV-FUNNEL-001: non-recurring unique)
            const existing = !values.isRecurring
              ? leadStagesTable.find(
                  (s) =>
                    s.workspaceId === values.workspaceId &&
                    s.leadId === values.leadId &&
                    s.launchId === values.launchId &&
                    s.stage === values.stage &&
                    !s.isRecurring,
                )
              : undefined;

            if (existing) {
              return Promise.reject(
                new Error(
                  'duplicate key value violates unique constraint (23505)',
                ),
              );
            }

            const stageRow: LeadStageRow = {
              id: `stage-uuid-${++stageUuidCounter}`,
              workspaceId: values.workspaceId as string,
              leadId: values.leadId as string,
              launchId: values.launchId as string,
              stage: values.stage as string,
              isRecurring: (values.isRecurring as boolean) ?? false,
              sourceEventId: values.sourceEventId as string,
              ts: new Date(),
            };
            leadStagesTable.push(stageRow);
            return Promise.resolve([]);
          }

          return Promise.resolve([]);
        }),
      };
    }),

    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn((condition: unknown) => {
          // Update raw_event status
          for (const [id, row] of rawEventsTable.entries()) {
            // Match any row (simplified — real query would filter by id)
            if (typeof values.processingStatus === 'string') {
              row.processingStatus = values.processingStatus as string;
            }
            if (values.processingError !== undefined) {
              row.processingError = values.processingError as string | null;
            }
            if (values.processedAt) {
              row.processedAt = values.processedAt as Date;
            }
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  };

  return { db, eventsTable, leadStagesTable, rawEventsTable, addRawEvent };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_ID = '11111111-1111-1111-1111-111111111111';
const PAGE_ID = '22222222-2222-2222-2222-222222222222';
const LAUNCH_ID = '33333333-3333-3333-3333-333333333333';
const RAW_ID = '44444444-4444-4444-4444-444444444444';
const LEAD_ID = '55555555-5555-5555-5555-555555555555';

function makeRawEvent(payloadOverrides?: Record<string, unknown>): RawEventRow {
  return {
    id: RAW_ID,
    workspaceId: WS_ID,
    pageId: PAGE_ID,
    processingStatus: 'pending',
    processingError: null,
    processedAt: null,
    receivedAt: new Date('2026-05-02T12:00:01Z'),
    headersSanitized: {},
    payload: {
      event_id: 'client-evt-integration-001',
      event_name: 'PageView',
      event_time: '2026-05-02T12:00:00Z',
      user_data: {},
      custom_data: { page: '/checkout' },
      attribution: { utm_source: 'google', utm_medium: 'cpc' },
      consent: {
        analytics: 'granted',
        marketing: 'granted',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
      ...payloadOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processRawEvent — integration (stateful mock DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Full pipeline: anonymous PageView
  // -------------------------------------------------------------------------

  it('anonymous PageView: inserts event row, marks raw_event processed, returns dispatch_jobs_created=0', async () => {
    const { db, eventsTable, rawEventsTable, addRawEvent } = makeStatefulDb();

    const rawRow = makeRawEvent();
    addRawEvent(rawRow);

    // Point the select mock to our rawEventsTable
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rawRow]),
        }),
      }),
    });

    const result = await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // event_id returned matches payload
    expect(result.value.event_id).toBe('client-evt-integration-001');

    // dispatch_jobs_created = 0 (OQ-011)
    expect(result.value.dispatch_jobs_created).toBe(0);

    // events row exists
    expect(eventsTable).toHaveLength(1);
    const eventRow = eventsTable[0];
    if (!eventRow) throw new Error('expected event row to be inserted');
    expect(eventRow.workspaceId).toBe(WS_ID);
    expect(eventRow.eventId).toBe('client-evt-integration-001');
    expect(eventRow.eventSource).toBe('tracker');
    expect(eventRow.schemaVersion).toBe(1);
    expect(eventRow.processingStatus).toBe('accepted');

    // INV-EVENT-006: consent_snapshot populated
    expect(eventRow.consentSnapshot).toEqual(
      expect.objectContaining({
        analytics: 'granted',
        marketing: 'granted',
        ad_user_data: 'unknown',
      }),
    );

    // raw_event marked as processed
    const updatedRaw = rawEventsTable.get(RAW_ID);
    expect(updatedRaw?.processingStatus).toBe('processed');
  });

  // -------------------------------------------------------------------------
  // Full pipeline: Lead event → creates lead_stage='lead_identified'
  // -------------------------------------------------------------------------

  it('Lead event: resolves lead, inserts event + lead_identified stage', async () => {
    const { db, eventsTable, leadStagesTable, addRawEvent } = makeStatefulDb();

    const rawRow = makeRawEvent({
      event_id: 'client-evt-lead-001',
      event_name: 'Lead',
      email: 'integration@example.com',
      launch_id: LAUNCH_ID,
    });
    addRawEvent(rawRow);

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID,
        was_created: true,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rawRow]),
        }),
      }),
    });

    const result = await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // INV-EVENT-007: lead_id populated
    expect(eventsTable[0]?.leadId).toBe(LEAD_ID);

    // lead_stage inserted
    expect(leadStagesTable).toHaveLength(1);
    expect(leadStagesTable[0]?.stage).toBe('lead_identified');
    expect(leadStagesTable[0]?.leadId).toBe(LEAD_ID);
    expect(leadStagesTable[0]?.launchId).toBe(LAUNCH_ID);
    expect(leadStagesTable[0]?.isRecurring).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Full pipeline: Purchase event → creates lead_stage='purchased'
  // -------------------------------------------------------------------------

  it('Purchase event with lead_id: inserts event + purchased stage', async () => {
    const { db, eventsTable, leadStagesTable, addRawEvent } = makeStatefulDb();

    const rawRow = makeRawEvent({
      event_id: 'client-evt-purchase-001',
      event_name: 'Purchase',
      lead_id: LEAD_ID,
      launch_id: LAUNCH_ID,
      custom_data: { value: 297.0, currency: 'BRL', order_id: 'ord-123' },
    });
    addRawEvent(rawRow);

    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rawRow]),
        }),
      }),
    });

    const result = await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);

    expect(eventsTable[0]?.leadId).toBe(LEAD_ID);
    expect(eventsTable[0]?.customData).toEqual(
      expect.objectContaining({ order_id: 'ord-123' }),
    );

    expect(leadStagesTable).toHaveLength(1);
    expect(leadStagesTable[0]?.stage).toBe('purchased');
  });

  // -------------------------------------------------------------------------
  // Idempotency: duplicate (workspace_id, event_id) → ok, no new row
  // INV-EVENT-001, BR-EVENT-002
  // -------------------------------------------------------------------------

  it('INV-EVENT-001: duplicate event_id returns ok with dispatch_jobs_created=0 without re-inserting', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    // Pre-populate events table with a conflicting event_id
    eventsTable.push({
      id: 'existing-evt',
      workspaceId: WS_ID,
      eventId: 'client-evt-dup-001',
      eventName: 'PageView',
      eventSource: 'tracker',
      schemaVersion: 1,
      eventTime: new Date(),
      receivedAt: new Date(),
      attribution: {},
      userData: {},
      customData: {},
      consentSnapshot: {
        analytics: 'unknown',
        marketing: 'unknown',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
      requestContext: {},
      processingStatus: 'accepted',
      createdAt: new Date(),
    });

    const rawRow = makeRawEvent({ event_id: 'client-evt-dup-001' });
    addRawEvent(rawRow);

    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rawRow]),
        }),
      }),
    });

    const result = await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only 1 row (the pre-existing one) — no duplicate inserted
    expect(eventsTable).toHaveLength(1);
    expect(result.value.dispatch_jobs_created).toBe(0);
  });

  // -------------------------------------------------------------------------
  // INV-EVENT-003: already-processed raw_event → ok, no re-insert
  // -------------------------------------------------------------------------

  it('INV-EVENT-003: already-processed raw_event returns ok without inserting event again', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    const alreadyProcessed = makeRawEvent({ event_id: 'client-evt-already' });
    alreadyProcessed.processingStatus = 'processed';
    addRawEvent(alreadyProcessed);

    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([alreadyProcessed]),
        }),
      }),
    });

    const result = await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);
    // No new event inserted
    expect(eventsTable).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // INV-EVENT-006: consent_snapshot always populated
  // -------------------------------------------------------------------------

  it('INV-EVENT-006: consent_snapshot defaults to all unknown when payload.consent absent', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    const rawRow = makeRawEvent({ event_id: 'client-evt-noconsent' });
    // Omit consent key by rebuilding payload without it (noDelete lint rule)
    const { consent: _omitConsent, ...payloadWithoutConsent } =
      rawRow.payload as Record<string, unknown>;
    rawRow.payload = payloadWithoutConsent;
    addRawEvent(rawRow);

    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rawRow]),
        }),
      }),
    });

    await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    const inserted = eventsTable[0];
    expect(inserted?.consentSnapshot).toEqual({
      analytics: 'unknown',
      marketing: 'unknown',
      ad_user_data: 'unknown',
      ad_personalization: 'unknown',
      customer_match: 'unknown',
    });
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001: processing_error must not contain PII
  // -------------------------------------------------------------------------

  it('BR-PRIVACY-001: processing_error does not contain PII when lead resolution fails', async () => {
    const { db, rawEventsTable, addRawEvent } = makeStatefulDb();

    const rawRow = makeRawEvent({
      event_id: 'client-evt-privacy',
      event_name: 'Lead',
      email: 'very-private@example.com',
    });
    addRawEvent(rawRow);

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: false,
      error: { code: 'db_error', message: 'connection error' },
    });

    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rawRow]),
        }),
      }),
    });

    await processRawEvent(
      RAW_ID,
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    const updatedRaw = rawEventsTable.get(RAW_ID);
    // BR-PRIVACY-001: processing_error must not contain the email
    expect(updatedRaw?.processingError ?? '').not.toContain(
      'very-private@example.com',
    );
  });

  // -------------------------------------------------------------------------
  // TODO (Sprint 3 — OQ-011): Real dispatch_jobs creation test
  //
  // When integration config table is implemented and MOD-DISPATCH.createDispatchJobs()
  // is wired, this test should verify:
  //   1. dispatch_jobs row inserted for each configured destination
  //   2. idempotency_key = sha256(workspace_id|event_id|destination|resource_id|subresource)
  //   3. dispatch_jobs_created count matches rows inserted
  //   4. status='pending' on all new jobs
  // -------------------------------------------------------------------------

  it.todo(
    'Sprint 3: dispatch_jobs created for each configured destination (OQ-011)',
  );
  it.todo(
    'Sprint 3: dispatch_jobs idempotency_key is deterministic per (workspace, event, destination)',
  );
  it.todo(
    'Sprint 3: re-processing same raw_event does not create duplicate dispatch_jobs',
  );
});
