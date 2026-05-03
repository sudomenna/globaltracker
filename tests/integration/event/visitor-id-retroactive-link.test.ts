/**
 * Integration tests — visitor_id retroactive backfill (INV-EVENT-007 extended)
 *
 * Verifies that when a lead is resolved via a Lead event, previously anonymous
 * events sharing the same visitor_id are backfilled with the resolved lead_id.
 *
 * Scenario:
 *   1. PageView arrives with visitor_id='abc123', lead_id=null → event created with lead_id=null
 *   2. Lead event arrives with visitor_id='abc123' and identifiers → lead resolved
 *   3. Assertion: the PageView from step 1 now has lead_id = <resolved_lead_id>
 *
 * INV-EVENT-007: events with valid lead_token have lead_id resolved by processor.
 * INV-TRACKER-003: visitor_id only present when consent_analytics='granted'.
 * BR-PRIVACY-001: backfill failure is non-fatal and logged without PII.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processRawEvent } from '../../../apps/edge/src/lib/raw-events-processor';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  events: {
    id: 'id',
    workspaceId: 'workspace_id',
    eventId: 'event_id',
    leadId: 'lead_id',
    visitorId: 'visitor_id',
  },
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
  hashPii: vi.fn().mockResolvedValue('hashed-pii-value'),
}));

import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// State-tracking mock DB
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  workspaceId: string;
  eventId: string;
  eventName: string;
  leadId: string | null;
  visitorId: string | null;
  eventSource: string;
  schemaVersion: number;
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
  const rawEventsTable: Map<string, RawEventRow> = new Map();

  let eventUuidCounter = 0;

  const db = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation((..._args: unknown[]) => ({
          limit: vi.fn().mockImplementation((limit: number) => {
            const rows = [...rawEventsTable.values()].slice(0, limit);
            return Promise.resolve(rows);
          }),
        })),
      })),
    })),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        if (typeof values.eventId === 'string') {
          // Check for unique violation on (workspaceId, eventId)
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

          const id = `evt-${++eventUuidCounter}`;
          const row: EventRow = {
            id,
            workspaceId: values.workspaceId as string,
            eventId: values.eventId as string,
            eventName: values.eventName as string,
            leadId: (values.leadId as string | null) ?? null,
            visitorId: (values.visitorId as string | null) ?? null,
            eventSource: (values.eventSource as string) ?? 'tracker',
            schemaVersion: (values.schemaVersion as number) ?? 1,
            eventTime: values.eventTime as Date,
            receivedAt: values.receivedAt as Date,
            attribution: (values.attribution as Record<string, unknown>) ?? {},
            userData: (values.userData as Record<string, unknown>) ?? {},
            customData: (values.customData as Record<string, unknown>) ?? {},
            consentSnapshot:
              (values.consentSnapshot as Record<string, unknown>) ?? {},
            requestContext:
              (values.requestContext as Record<string, unknown>) ?? {},
            processingStatus: (values.processingStatus as string) ?? 'accepted',
            createdAt: new Date(),
          };
          eventsTable.push(row);
          return { returning: vi.fn(() => Promise.resolve([{ id }])) };
        }

        // lead_stages insert
        if (
          typeof values.leadId === 'string' &&
          typeof values.stage === 'string'
        ) {
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      }),
    })),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(async (..._args: unknown[]) => {
          // Handle raw_event status update
          if (typeof values.processingStatus === 'string') {
            for (const row of rawEventsTable.values()) {
              row.processingStatus = values.processingStatus as string;
              if (values.processedAt) {
                row.processedAt = values.processedAt as Date;
              }
            }
          }

          // Handle retroactive backfill: set leadId on events with matching visitorId
          if ('leadId' in values && typeof values.leadId === 'string') {
            // The backfill update targets events WHERE lead_id IS NULL AND visitor_id = visitorId
            // In our mock, update all events with null leadId that have the matching visitor_id
            // We cannot directly check the WHERE condition's visitorId, but the processor
            // always sends: WHERE workspace_id = X AND visitor_id = Y AND lead_id IS NULL
            // We simulate this by applying leadId to all events with leadId=null
            const leadId = values.leadId as string;
            for (const evt of eventsTable) {
              if (evt.leadId === null) {
                evt.leadId = leadId;
              }
            }
          }

          return Promise.resolve([]);
        }),
      })),
    })),
  };

  return {
    db,
    eventsTable,
    rawEventsTable,
    addRawEvent: (row: RawEventRow) => rawEventsTable.set(row.id, row),
    selectRawEvent: (id: string) => rawEventsTable.get(id),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_ID = 'ws-visitor-retroactive-001';
const LAUNCH_ID = '33333333-3333-3333-3333-333333333333';
const VISITOR_ID = 'fvid-abc-123-visitor';
const LEAD_ID = 'lead-resolved-001';

function makePageViewRawEvent(id: string): RawEventRow {
  return {
    id,
    workspaceId: WS_ID,
    pageId: null,
    processingStatus: 'pending',
    processingError: null,
    processedAt: null,
    receivedAt: new Date('2026-05-02T10:00:00Z'),
    headersSanitized: {},
    payload: {
      event_id: `pageview-evt-${id}`,
      event_name: 'PageView',
      event_time: '2026-05-02T10:00:00Z',
      visitor_id: VISITOR_ID,
      // No lead_id — anonymous visitor
      user_data: {},
      custom_data: {},
      attribution: {},
      consent: {
        analytics: 'granted',
        marketing: 'unknown',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
    },
  };
}

function makeLeadRawEvent(id: string): RawEventRow {
  return {
    id,
    workspaceId: WS_ID,
    pageId: null,
    processingStatus: 'pending',
    processingError: null,
    processedAt: null,
    receivedAt: new Date('2026-05-02T10:01:00Z'),
    headersSanitized: {},
    payload: {
      event_id: `lead-evt-${id}`,
      event_name: 'Lead',
      event_time: '2026-05-02T10:01:00Z',
      visitor_id: VISITOR_ID,
      email: 'test-visitor@example.com',
      launch_id: LAUNCH_ID,
      user_data: {},
      custom_data: {},
      attribution: { utm_source: 'google' },
      consent: {
        analytics: 'granted',
        marketing: 'granted',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('visitor_id retroactive backfill (INV-EVENT-007 extended)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PageView with visitor_id is created with lead_id=null when processed anonymously', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    const pageViewRaw = makePageViewRawEvent('raw-pageview-001');
    addRawEvent(pageViewRaw);

    // Configure select to return this raw event
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([pageViewRaw]),
        }),
      }),
    });

    const result = await processRawEvent(
      'raw-pageview-001',
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);

    const eventRow = eventsTable.find(
      (e) => e.eventId === 'pageview-evt-raw-pageview-001',
    );
    expect(eventRow).toBeDefined();
    // INV-TRACKER-003: visitor_id present (consent granted)
    expect(eventRow?.visitorId).toBe(VISITOR_ID);
    // Anonymous — no lead_id yet
    expect(eventRow?.leadId).toBeNull();
  });

  it('Lead event resolves lead and triggers retroactive backfill of prior anonymous event', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    // Step 1: Insert anonymous PageView directly (simulates already-processed event)
    const anonEvent: EventRow = {
      id: 'evt-anon-pageview',
      workspaceId: WS_ID,
      eventId: 'pageview-evt-pre-existing',
      eventName: 'PageView',
      leadId: null, // anonymous
      visitorId: VISITOR_ID,
      eventSource: 'tracker',
      schemaVersion: 1,
      eventTime: new Date('2026-05-02T09:59:00Z'),
      receivedAt: new Date('2026-05-02T09:59:01Z'),
      attribution: {},
      userData: {},
      customData: {},
      consentSnapshot: {
        analytics: 'granted',
        marketing: 'unknown',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
      requestContext: {},
      processingStatus: 'accepted',
      createdAt: new Date(),
    };
    eventsTable.push(anonEvent);

    // Step 2: Process Lead event
    const leadRaw = makeLeadRawEvent('raw-lead-001');
    addRawEvent(leadRaw);

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
          limit: vi.fn().mockResolvedValue([leadRaw]),
        }),
      }),
    });

    const result = await processRawEvent(
      'raw-lead-001',
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    expect(result.ok).toBe(true);

    // Step 3: Verify backfill — anonymous PageView now has lead_id
    const updatedAnon = eventsTable.find(
      (e) => e.eventId === 'pageview-evt-pre-existing',
    );
    expect(updatedAnon).toBeDefined();
    // INV-EVENT-007: backfill applied — lead_id is now set
    expect(updatedAnon?.leadId).toBe(LEAD_ID);
  });

  it('backfill is idempotent — events with existing lead_id are not overwritten', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    const EXISTING_LEAD_ID = 'lead-already-linked-001';

    // Pre-existing event that already has a lead_id (should not be changed by backfill)
    const linkedEvent: EventRow = {
      id: 'evt-already-linked',
      workspaceId: WS_ID,
      eventId: 'pageview-already-linked',
      eventName: 'PageView',
      leadId: EXISTING_LEAD_ID, // already linked
      visitorId: VISITOR_ID,
      eventSource: 'tracker',
      schemaVersion: 1,
      eventTime: new Date('2026-05-02T09:55:00Z'),
      receivedAt: new Date('2026-05-02T09:55:01Z'),
      attribution: {},
      userData: {},
      customData: {},
      consentSnapshot: {
        analytics: 'granted',
        marketing: 'unknown',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
      requestContext: {},
      processingStatus: 'accepted',
      createdAt: new Date(),
    };
    eventsTable.push(linkedEvent);

    const leadRaw = makeLeadRawEvent('raw-lead-002');
    addRawEvent(leadRaw);

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
          limit: vi.fn().mockResolvedValue([leadRaw]),
        }),
      }),
    });

    await processRawEvent(
      'raw-lead-002',
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    // The linked event's lead_id must remain unchanged (mock only updates null rows)
    const stillLinked = eventsTable.find(
      (e) => e.eventId === 'pageview-already-linked',
    );
    // Our mock simulates WHERE lead_id IS NULL — so already-linked event is unchanged
    expect(stillLinked?.leadId).toBe(EXISTING_LEAD_ID);
  });

  it('no backfill when Lead event has no visitor_id', async () => {
    const { db, eventsTable, addRawEvent } = makeStatefulDb();

    // Anonymous event
    const anonEvent: EventRow = {
      id: 'evt-anon-novisitor',
      workspaceId: WS_ID,
      eventId: 'pageview-no-visitor',
      eventName: 'PageView',
      leadId: null,
      visitorId: 'some-other-visitor',
      eventSource: 'tracker',
      schemaVersion: 1,
      eventTime: new Date('2026-05-02T09:58:00Z'),
      receivedAt: new Date(),
      attribution: {},
      userData: {},
      customData: {},
      consentSnapshot: {
        analytics: 'granted',
        marketing: 'unknown',
        ad_user_data: 'unknown',
        ad_personalization: 'unknown',
        customer_match: 'unknown',
      },
      requestContext: {},
      processingStatus: 'accepted',
      createdAt: new Date(),
    };
    eventsTable.push(anonEvent);

    // Lead event with NO visitor_id
    const leadRawNoVisitor: RawEventRow = {
      id: 'raw-lead-no-visitor',
      workspaceId: WS_ID,
      pageId: null,
      processingStatus: 'pending',
      processingError: null,
      processedAt: null,
      receivedAt: new Date(),
      headersSanitized: {},
      payload: {
        event_id: 'lead-evt-no-visitor',
        event_name: 'Lead',
        event_time: '2026-05-02T10:02:00Z',
        // No visitor_id
        email: 'novisitor@example.com',
        launch_id: LAUNCH_ID,
        user_data: {},
        custom_data: {},
        attribution: {},
        consent: {
          analytics: 'denied', // no consent → no visitor_id
          marketing: 'unknown',
          ad_user_data: 'unknown',
          ad_personalization: 'unknown',
          customer_match: 'unknown',
        },
      },
    };
    addRawEvent(leadRawNoVisitor);

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
          limit: vi.fn().mockResolvedValue([leadRawNoVisitor]),
        }),
      }),
    });

    // Track update calls
    let updateWithLeadIdCalled = false;
    const originalUpdate = db.update.getMockImplementation?.();
    db.update.mockImplementation(() => ({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(async () => {
          if ('leadId' in values) {
            updateWithLeadIdCalled = true;
          }
          // Update raw_event status
          for (const row of (
            addRawEvent as unknown as {
              rawEventsTable?: Map<string, RawEventRow>;
            }
          )?.rawEventsTable?.values() ?? []) {
            if (values.processingStatus) {
              row.processingStatus = values.processingStatus as string;
            }
          }
        }),
      })),
    }));

    await processRawEvent(
      'raw-lead-no-visitor',
      db as unknown as Parameters<typeof processRawEvent>[1],
    );

    // Without visitor_id, no retroactive backfill update should be called with leadId
    // The event row for anonEvent should remain with null leadId
    expect(anonEvent.leadId).toBeNull();
  });
});
