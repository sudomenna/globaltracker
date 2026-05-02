/**
 * Unit tests for apps/edge/src/lib/raw-events-processor.ts
 *
 * All DB and dependencies are mocked — no real DB required.
 *
 * Coverage targets:
 *   - Happy path: Lead event with PII → resolves lead, inserts event, inserts lead_stage
 *   - Happy path: Purchase event → inserts event + 'purchased' lead_stage
 *   - Happy path: Anonymous PageView → inserts event without lead resolution
 *   - Idempotency: duplicate event_id (unique violation) → marks processed, returns ok
 *   - Not found: raw_event_id does not exist → error not_found
 *   - Wrong status: raw_event already 'processed' → returns ok with event_id
 *   - Wrong status: raw_event is 'failed' → error wrong_status
 *   - Invalid payload: missing required fields → marks failed, returns error
 *   - Lead resolution failure → marks failed, returns error
 *   - INV-EVENT-006: consent_snapshot defaults to all 'unknown' when absent
 *   - BR-EVENT-005: user_data with non-canonical keys → stripped (not fatal)
 *   - BR-PRIVACY-001: PII fields (email/phone) never appear in returned error messages
 *
 * BRs applied:
 *   BR-EVENT-002: idempotency on (workspace_id, event_id)
 *   BR-EVENT-005: user_data canonical only
 *   BR-PRIVACY-001: PII never in logs
 *   BR-IDENTITY-003: merged lead → use canonical lead_id
 *   INV-EVENT-001: unique (workspace_id, event_id) in events
 *   INV-EVENT-003: already-processed raw_event returns ok without re-insert
 *   INV-EVENT-006: consent_snapshot always populated
 *   INV-EVENT-007: lead_id resolved from PII when event is identify-type
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsentSnapshotSchema,
  RawEventPayloadSchema,
  UserDataSchema,
  processRawEvent,
} from '../../../apps/edge/src/lib/raw-events-processor';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// Mock @globaltracker/db to avoid real Drizzle imports
vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
}));

// Mock lead-resolver
vi.mock('../../../apps/edge/src/lib/lead-resolver', () => ({
  resolveLeadByAliases: vi.fn(),
}));

// Mock attribution
vi.mock('../../../apps/edge/src/lib/attribution', () => ({
  recordTouches: vi.fn().mockResolvedValue({
    ok: true,
    value: { first_created: true, last_updated: true },
  }),
}));

// Mock pii (hashPii)
vi.mock('../../../apps/edge/src/lib/pii', () => ({
  hashPii: vi.fn().mockResolvedValue('abc123hash'),
}));

import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

type MockDbCall = {
  type: 'select' | 'insert' | 'update';
  table?: string;
};

/**
 * Creates a minimal mock of the Drizzle Db object.
 * Interactions are recorded via vi.fn() for assertions.
 */
function makeMockDb(overrides?: {
  rawEventRow?: Record<string, unknown> | null;
  insertEventsThrows?: Error | null;
  insertEventsReturns?: Array<{ id: string }>;
}) {
  const rawEventRow = overrides?.rawEventRow ?? null;
  const insertEventsThrows = overrides?.insertEventsThrows ?? null;
  const insertEventsReturns = overrides?.insertEventsReturns ?? [
    { id: 'evt-uuid-001' },
  ];

  const updateFn = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  const insertLeadStagesFn = vi.fn().mockResolvedValue([]);

  const insertEventsFn = vi.fn(() => {
    if (insertEventsThrows) {
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(insertEventsThrows),
        }),
      };
    }
    return {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertEventsReturns),
      }),
    };
  });

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rawEventRow ? [rawEventRow] : []),
        }),
      }),
    }),
    insert: vi.fn((table: unknown) => {
      // Return different mocks based on which table is being inserted
      // We distinguish by checking the table reference identity in tests
      // In the processor, events is imported from @globaltracker/db
      // Since we mock the module, both tables are plain objects — check by table reference
      if (
        table ===
        require('../../../apps/edge/src/lib/raw-events-processor')
          .UserDataSchema
      ) {
        // Should not happen — just a safety guard
        return insertLeadStagesFn();
      }
      return insertEventsFn()();
    }),
    update: updateFn,
  };

  return { db, updateFn, insertEventsFn, insertLeadStagesFn };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const PAGE_ID = '22222222-2222-2222-2222-222222222222';
const LAUNCH_ID = '33333333-3333-3333-3333-333333333333';
const RAW_EVENT_ID = '44444444-4444-4444-4444-444444444444';
const LEAD_ID = '55555555-5555-5555-5555-555555555555';
const EVENT_TIME = '2026-05-02T12:00:00Z';

function makeRawEventRow(payloadOverrides?: Record<string, unknown>) {
  return {
    id: RAW_EVENT_ID,
    workspaceId: WORKSPACE_ID,
    pageId: PAGE_ID,
    processingStatus: 'pending',
    receivedAt: new Date('2026-05-02T12:00:01Z'),
    processedAt: null,
    processingError: null,
    headersSanitized: {},
    payload: {
      event_id: 'evt-client-001',
      event_name: 'PageView',
      event_time: EVENT_TIME,
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
      ...payloadOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for DB mock that properly handles table discrimination
// ---------------------------------------------------------------------------

/**
 * Creates a full Drizzle-compatible mock where insert behavior varies by call order:
 * first insert = events table, subsequent inserts = leadStages.
 */
function makeMockDbFull(opts?: {
  rawEventRow?: Record<string, unknown> | null;
  insertEventsThrows?: Error | null;
  insertEventsReturns?: Array<{ id: string }>;
  resolveLeadResult?: {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
}) {
  const rawEventRow = opts?.rawEventRow ?? null;
  const insertEventsThrows = opts?.insertEventsThrows ?? null;
  const insertEventsReturns = opts?.insertEventsReturns ?? [
    { id: 'evt-uuid-001' },
  ];

  const updateSetWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  // Events insert chain
  const eventsReturning = insertEventsThrows
    ? vi.fn().mockRejectedValue(insertEventsThrows)
    : vi.fn().mockResolvedValue(insertEventsReturns);
  const eventsValues = vi.fn().mockReturnValue({ returning: eventsReturning });

  // Lead stages insert (resolves with empty array — no returning needed)
  const leadStagesValues = vi.fn().mockResolvedValue([]);

  let insertCallCount = 0;
  const insert = vi.fn(() => {
    insertCallCount++;
    if (insertCallCount === 1) {
      // First insert call = events table
      return { values: eventsValues };
    }
    // Subsequent = leadStages
    return { values: leadStagesValues };
  });

  const selectLimitFn = vi
    .fn()
    .mockResolvedValue(rawEventRow ? [rawEventRow] : []);
  const selectWhereFn = vi.fn().mockReturnValue({ limit: selectLimitFn });
  const selectFromFn = vi.fn().mockReturnValue({ where: selectWhereFn });
  const select = vi.fn().mockReturnValue({ from: selectFromFn });

  const db = { select, insert, update } as unknown as Parameters<
    typeof processRawEvent
  >[1];

  return {
    db,
    update,
    updateSet,
    updateSetWhere,
    insert,
    eventsValues,
    eventsReturning,
    leadStagesValues,
    selectLimitFn,
  };
}

// ---------------------------------------------------------------------------
// Schema unit tests (no DB needed)
// ---------------------------------------------------------------------------

describe('UserDataSchema', () => {
  it('BR-EVENT-005: accepts canonical hashed keys', () => {
    const result = UserDataSchema.safeParse({
      em: 'abc123',
      ph: 'def456',
      fbc: '_fbc_...',
      fbp: '_fbp_...',
    });
    expect(result.success).toBe(true);
  });

  it('BR-EVENT-005: rejects email in clear', () => {
    const result = UserDataSchema.safeParse({ email: 'test@example.com' });
    expect(result.success).toBe(false);
  });

  it('BR-EVENT-005: rejects phone in clear', () => {
    const result = UserDataSchema.safeParse({ phone: '+55 11 99999-9999' });
    expect(result.success).toBe(false);
  });

  it('BR-EVENT-005: rejects name in clear', () => {
    const result = UserDataSchema.safeParse({ name: 'João Silva' });
    expect(result.success).toBe(false);
  });

  it('BR-EVENT-005: rejects ip in clear', () => {
    const result = UserDataSchema.safeParse({ ip: '192.168.1.1' });
    expect(result.success).toBe(false);
  });

  it('accepts empty object', () => {
    const result = UserDataSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('ConsentSnapshotSchema', () => {
  it('INV-EVENT-006: defaults all values to unknown when empty', () => {
    const result = ConsentSnapshotSchema.parse(undefined);
    expect(result).toEqual({
      analytics: 'unknown',
      marketing: 'unknown',
      ad_user_data: 'unknown',
      ad_personalization: 'unknown',
      customer_match: 'unknown',
    });
  });

  it('INV-EVENT-006: accepts partial consent (fills missing keys with unknown)', () => {
    const result = ConsentSnapshotSchema.parse({ analytics: 'granted' });
    expect(result.analytics).toBe('granted');
    expect(result.marketing).toBe('unknown');
  });

  it('rejects invalid consent values', () => {
    const result = ConsentSnapshotSchema.safeParse({ analytics: 'yes' });
    expect(result.success).toBe(false);
  });
});

describe('RawEventPayloadSchema', () => {
  it('accepts a valid minimal payload', () => {
    const result = RawEventPayloadSchema.safeParse({
      event_id: 'evt-001',
      event_name: 'PageView',
      event_time: '2026-05-02T12:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects payload missing event_id', () => {
    const result = RawEventPayloadSchema.safeParse({
      event_name: 'PageView',
      event_time: '2026-05-02T12:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload with invalid event_time (not ISO datetime)', () => {
    const result = RawEventPayloadSchema.safeParse({
      event_id: 'evt-001',
      event_name: 'PageView',
      event_time: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processRawEvent unit tests
// ---------------------------------------------------------------------------

describe('processRawEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------

  it('returns not_found when raw_event_id does not exist', async () => {
    const { db } = makeMockDbFull({ rawEventRow: null });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  // -------------------------------------------------------------------------
  // Already processed (INV-EVENT-003)
  // -------------------------------------------------------------------------

  it('INV-EVENT-003: returns ok without re-insert when raw_event is already processed', async () => {
    const alreadyProcessed = makeRawEventRow();
    alreadyProcessed.processingStatus = 'processed';

    const { db, insert } = makeMockDbFull({ rawEventRow: alreadyProcessed });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toBe('evt-client-001');
    expect(result.value.dispatch_jobs_created).toBe(0);
    // Must NOT insert into events table again
    expect(insert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Wrong status
  // -------------------------------------------------------------------------

  it('returns wrong_status when raw_event is not pending or processed', async () => {
    const failedRow = makeRawEventRow();
    failedRow.processingStatus = 'failed';

    const { db } = makeMockDbFull({ rawEventRow: failedRow });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('wrong_status');
    expect((result.error as { current_status: string }).current_status).toBe(
      'failed',
    );
  });

  // -------------------------------------------------------------------------
  // Invalid payload
  // -------------------------------------------------------------------------

  it('returns invalid_payload and marks raw_event failed when payload is missing required fields', async () => {
    const badPayloadRow = {
      ...makeRawEventRow(),
      payload: { event_name: 'PageView' }, // missing event_id and event_time
    };

    const { db, updateSet } = makeMockDbFull({ rawEventRow: badPayloadRow });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_payload');
    // Should have called update to mark as failed
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'failed' }),
    );
  });

  // -------------------------------------------------------------------------
  // Happy path: anonymous PageView
  // -------------------------------------------------------------------------

  it('happy path: anonymous PageView inserts event without lead resolution', async () => {
    const rawRow = makeRawEventRow({
      event_name: 'PageView',
      event_id: 'evt-pageview-001',
    });

    const { db, eventsValues, updateSet } = makeMockDbFull({
      rawEventRow: rawRow,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toBe('evt-pageview-001');
    expect(result.value.dispatch_jobs_created).toBe(0);

    // Should have called insert for events
    expect(eventsValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        eventId: 'evt-pageview-001',
        eventName: 'PageView',
        eventSource: 'tracker',
        schemaVersion: 1,
      }),
    );

    // Should have marked raw_event as processed
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'processed' }),
    );

    // Should NOT have called resolveLeadByAliases (anonymous event)
    expect(resolveLeadByAliases).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path: Lead event with email → resolves lead, inserts lead_stage
  // -------------------------------------------------------------------------

  it('INV-EVENT-007: Lead event with email resolves lead_id and inserts lead_identified stage', async () => {
    const rawRow = makeRawEventRow({
      event_name: 'Lead',
      event_id: 'evt-lead-001',
      email: 'user@example.com',
      launch_id: LAUNCH_ID,
    });

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID,
        was_created: true,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    let insertCallIndex = 0;
    const eventsReturning = vi.fn().mockResolvedValue([{ id: 'evt-uuid-002' }]);
    const eventsValues = vi
      .fn()
      .mockReturnValue({ returning: eventsReturning });
    const leadStagesValues = vi.fn().mockResolvedValue([]);

    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });

    const insert = vi.fn(() => {
      insertCallIndex++;
      if (insertCallIndex === 1) {
        return { values: eventsValues };
      }
      return { values: leadStagesValues };
    });

    const selectLimitFn = vi.fn().mockResolvedValue([rawRow]);
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: selectLimitFn }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toBe('evt-lead-001');

    // Should have called resolveLeadByAliases
    expect(resolveLeadByAliases).toHaveBeenCalledWith(
      { email: 'user@example.com', phone: undefined, external_id: undefined },
      WORKSPACE_ID,
      db,
    );

    // events insert should have lead_id populated
    expect(eventsValues).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: LEAD_ID,
        eventName: 'Lead',
      }),
    );

    // lead_stages insert should have been called with stage='lead_identified'
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'lead_identified',
        isRecurring: false,
        leadId: LEAD_ID,
        launchId: LAUNCH_ID,
        sourceEventId: 'evt-uuid-002',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Happy path: Purchase event → lead_stage 'purchased'
  // -------------------------------------------------------------------------

  it('Purchase event with lead_id creates purchased lead_stage', async () => {
    const rawRow = makeRawEventRow({
      event_name: 'Purchase',
      event_id: 'evt-purchase-001',
      lead_id: LEAD_ID,
      launch_id: LAUNCH_ID,
    });

    let insertCallIndex = 0;
    const eventsReturning = vi.fn().mockResolvedValue([{ id: 'evt-uuid-003' }]);
    const eventsValues = vi
      .fn()
      .mockReturnValue({ returning: eventsReturning });
    const leadStagesValues = vi.fn().mockResolvedValue([]);

    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });

    const insert = vi.fn(() => {
      insertCallIndex++;
      if (insertCallIndex === 1) return { values: eventsValues };
      return { values: leadStagesValues };
    });

    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);

    // Should NOT call resolveLeadByAliases (lead_id already provided)
    expect(resolveLeadByAliases).not.toHaveBeenCalled();

    // lead_stages should have stage='purchased'
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'purchased',
        isRecurring: false,
        leadId: LEAD_ID,
        launchId: LAUNCH_ID,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // No lead_stage when no launch_id (stage requires both lead + launch)
  // -------------------------------------------------------------------------

  it('Lead event without launch_id does not insert lead_stage', async () => {
    const rawRow = makeRawEventRow({
      event_name: 'Lead',
      event_id: 'evt-lead-no-launch',
      email: 'nolaunch@example.com',
      // No launch_id
    });

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID,
        was_created: true,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    let insertCallIndex = 0;
    const eventsValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'evt-uuid-004' }]),
    });
    const leadStagesValues = vi.fn().mockResolvedValue([]);

    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateSetWhere }),
    });

    const insert = vi.fn(() => {
      insertCallIndex++;
      if (insertCallIndex === 1) return { values: eventsValues };
      return { values: leadStagesValues };
    });

    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    // lead_stages insert should NOT have been called
    expect(leadStagesValues).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idempotency: duplicate event_id (BR-EVENT-002 / INV-EVENT-001)
  // -------------------------------------------------------------------------

  it('BR-EVENT-002: unique violation on events insert → marks processed as duplicate, returns ok', async () => {
    const rawRow = makeRawEventRow({
      event_id: 'evt-duplicate-001',
      event_name: 'PageView',
    });

    const uniqueError = new Error(
      'duplicate key value violates unique constraint (23505)',
    );

    const { db, updateSet } = makeMockDbFull({
      rawEventRow: rawRow,
      insertEventsThrows: uniqueError,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toBe('evt-duplicate-001');
    expect(result.value.dispatch_jobs_created).toBe(0);

    // Should mark raw_event as processed (not failed)
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'processed' }),
    );
  });

  it('BR-EVENT-002: "unique" violation message also triggers idempotent path', async () => {
    const rawRow = makeRawEventRow({
      event_id: 'evt-dup-002',
      event_name: 'PageView',
    });
    const uniqueError = new Error('unique constraint violation');

    const { db } = makeMockDbFull({
      rawEventRow: rawRow,
      insertEventsThrows: uniqueError,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Non-unique DB error → marks failed, returns db_error
  // -------------------------------------------------------------------------

  it('non-unique DB error on events insert → marks raw_event failed, returns db_error', async () => {
    const rawRow = makeRawEventRow({
      event_id: 'evt-dberr-001',
      event_name: 'PageView',
    });
    const dbError = new Error('connection timeout');

    const { db, updateSet } = makeMockDbFull({
      rawEventRow: rawRow,
      insertEventsThrows: dbError,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('db_error');

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'failed' }),
    );
  });

  // -------------------------------------------------------------------------
  // Lead resolution failure
  // -------------------------------------------------------------------------

  it('lead resolution failure → marks raw_event failed, returns lead_resolution_failed', async () => {
    const rawRow = makeRawEventRow({
      event_name: 'Lead',
      event_id: 'evt-resolve-fail',
      email: 'bad@example.com',
    });

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: false,
      error: { code: 'db_error', message: 'DB unreachable' },
    });

    const { db, updateSet } = makeMockDbFull({ rawEventRow: rawRow });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('lead_resolution_failed');

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'failed' }),
    );
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001: PII must not appear in error messages or processing_error
  // -------------------------------------------------------------------------

  it('BR-PRIVACY-001: PII (email) does not appear in processing_error stored on failure', async () => {
    const rawRow = makeRawEventRow({
      event_name: 'Lead',
      event_id: 'evt-pii-check',
      email: 'secret@example.com',
    });

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: false,
      error: { code: 'db_error', message: 'generic db error' },
    });

    let storedError = '';
    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi
      .fn()
      .mockImplementation((values: Record<string, unknown>) => {
        if (typeof values.processingError === 'string') {
          storedError = values.processingError;
        }
        return { where: updateSetWhere };
      });
    const update = vi.fn().mockReturnValue({ set: updateSet });

    const eventsValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'evt-uuid' }]),
    });
    const insert = vi.fn().mockReturnValue({ values: eventsValues });

    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    await processRawEvent(RAW_EVENT_ID, db);

    // BR-PRIVACY-001: PII must not be stored in processing_error
    expect(storedError).not.toContain('secret@example.com');
  });

  // -------------------------------------------------------------------------
  // INV-EVENT-006: consent_snapshot defaults to all 'unknown' when absent
  // -------------------------------------------------------------------------

  it('INV-EVENT-006: events insert contains consent_snapshot even when payload.consent absent', async () => {
    const rawRow = makeRawEventRow({
      event_id: 'evt-consent-default',
      event_name: 'PageView',
      // No consent field — should default to all 'unknown'
    });
    // Omit consent key by rebuilding payload without it (noDelete lint rule)
    const { consent: _omitConsent, ...payloadWithoutConsent } =
      rawRow.payload as Record<string, unknown>;
    rawRow.payload = payloadWithoutConsent as typeof rawRow.payload;

    const eventsReturning = vi
      .fn()
      .mockResolvedValue([{ id: 'evt-uuid-consent' }]);
    const eventsValues = vi
      .fn()
      .mockReturnValue({ returning: eventsReturning });
    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const insert = vi.fn().mockReturnValue({ values: eventsValues });
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    expect(eventsValues).toHaveBeenCalledWith(
      expect.objectContaining({
        consentSnapshot: expect.objectContaining({
          analytics: 'unknown',
          marketing: 'unknown',
          ad_user_data: 'unknown',
          ad_personalization: 'unknown',
          customer_match: 'unknown',
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // BR-EVENT-005: user_data non-canonical keys are stripped, not fatal
  // -------------------------------------------------------------------------

  it('BR-EVENT-005: user_data with non-canonical keys is stripped but event still inserted', async () => {
    const rawRow = makeRawEventRow({
      event_id: 'evt-userdata-strip',
      event_name: 'PageView',
      user_data: {
        em: 'abc123hash', // canonical
        email: 'user@example.com', // non-canonical — should be stripped
      },
    });

    const eventsValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'evt-uuid-ud' }]),
    });
    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateSetWhere }),
    });
    const insert = vi.fn().mockReturnValue({ values: eventsValues });
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);

    // userData inserted should not contain 'email' in clear
    const insertCall = eventsValues.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const userData = insertCall?.userData as
      | Record<string, unknown>
      | undefined;
    expect(userData).not.toHaveProperty('email');
  });

  // -------------------------------------------------------------------------
  // BR-IDENTITY-003: merge_executed → use canonical lead_id
  // -------------------------------------------------------------------------

  it('BR-IDENTITY-003: merge_executed lead uses canonical lead_id in events row', async () => {
    const MERGED_LEAD_ID = '66666666-6666-6666-6666-666666666666';
    const CANONICAL_LEAD_ID = '77777777-7777-7777-7777-777777777777';

    const rawRow = makeRawEventRow({
      event_name: 'Lead',
      event_id: 'evt-merge-001',
      email: 'merged@example.com',
      launch_id: LAUNCH_ID,
    });

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: CANONICAL_LEAD_ID, // canonical after merge
        was_created: false,
        merge_executed: true,
        merged_lead_ids: [MERGED_LEAD_ID],
      },
    });

    let insertIdx = 0;
    const eventsValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'evt-uuid-merge' }]),
    });
    const leadStagesValues = vi.fn().mockResolvedValue([]);

    const insert = vi.fn(() => {
      insertIdx++;
      if (insertIdx === 1) return { values: eventsValues };
      return { values: leadStagesValues };
    });

    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateSetWhere }),
    });
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    // events row must use canonical lead_id, not merged
    expect(eventsValues).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: CANONICAL_LEAD_ID }),
    );
  });

  // -------------------------------------------------------------------------
  // dispatch_jobs_created is always 0 in Sprint 2 (OQ-011)
  // -------------------------------------------------------------------------

  it('OQ-011: dispatch_jobs_created is 0 for all events in Sprint 2', async () => {
    const rawRow = makeRawEventRow({
      event_id: 'evt-dispatch-check',
      event_name: 'Purchase',
      lead_id: LEAD_ID,
      launch_id: LAUNCH_ID,
    });

    let insertIdx = 0;
    const eventsValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'evt-uuid' }]),
    });
    const leadStagesValues = vi.fn().mockResolvedValue([]);
    const insert = vi.fn(() => {
      insertIdx++;
      return insertIdx === 1
        ? { values: eventsValues }
        : { values: leadStagesValues };
    });

    const updateSetWhere = vi.fn().mockResolvedValue([]);
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateSetWhere }),
    });
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([rawRow]) }),
      }),
    });

    const db = { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1];

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dispatch_jobs_created).toBe(0);
  });
});
