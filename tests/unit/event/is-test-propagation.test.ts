/**
 * Unit tests — is_test flag propagation through the ingestion pipeline
 *
 * T-ID: T-8-006
 *
 * Covers:
 *   1. events.ts: isTestModeRequest detects X-GT-Test-Mode:1 header and embeds
 *      is_test=true into the raw_events payload passed to insertRawEvent.
 *   2. raw-events-processor.ts: is_test=true in raw payload → events.isTest=true on INSERT.
 *   3. raw-events-processor.ts: is_test absent (default false) → events.isTest=false.
 *
 * BR-TEST-MODE: Edge route embeds is_test flag in raw payload so the async
 *   processor can propagate it to events.is_test without needing the original headers.
 * BR-PRIVACY-001: is_test is not PII — no special restriction applies.
 *
 * All DB and external deps are mocked — no real DB required.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventsRoute } from '../../../apps/edge/src/routes/events.js';
import {
  RawEventPayloadSchema,
  processRawEvent,
} from '../../../apps/edge/src/lib/raw-events-processor.js';

// ---------------------------------------------------------------------------
// Mocks for raw-events-processor dependencies
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
}));

vi.mock('../../../apps/edge/src/lib/lead-resolver.js', () => ({
  resolveLeadByAliases: vi.fn(),
}));

vi.mock('../../../apps/edge/src/lib/attribution.js', () => ({
  recordTouches: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));

vi.mock('../../../apps/edge/src/lib/pii.js', () => ({
  hashPii: vi.fn().mockResolvedValue('abc123hash'),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-propagation-aabb';
const PAGE_ID = 'pg-test-propagation-ccdd';
const EVENT_ID = 'evt-test-propagation-0001';
const EVENT_TIME = '2026-05-02T12:00:00.000Z';

// ---------------------------------------------------------------------------
// PART 1: events.ts route — is_test embedded in raw payload
//
// Tests that isTestModeRequest detects the X-GT-Test-Mode:1 header and
// sets is_test=true in the payload object passed to insertRawEvent.
// ---------------------------------------------------------------------------

describe('events route: is_test flag embedded in raw payload', () => {
  /**
   * Builds a minimal Hono app wrapping the events route, with:
   *  - auth middleware replaced by direct context injection
   *  - a mock KV that always returns no-replay (null)
   *  - an injectable insertRawEvent spy
   */
  function buildEventsApp(insertRawEvent: ReturnType<typeof vi.fn>) {
    const kv: KVNamespace = {
      get: vi.fn().mockResolvedValue(null), // no replay match
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    } as unknown as KVNamespace;

    const queue: Queue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    const app = new Hono<{
      Bindings: {
        GT_KV: KVNamespace;
        QUEUE_EVENTS: Queue;
        QUEUE_DISPATCH: Queue;
        ENVIRONMENT: string;
      };
      Variables: {
        workspace_id: string;
        page_id: string;
        request_id: string;
      };
    }>();

    // Inject workspace context (simulates auth + public-token middleware)
    app.use('*', async (c, next) => {
      c.set('workspace_id', WORKSPACE_ID);
      c.set('page_id', PAGE_ID);
      c.set('request_id', 'req-test-001');
      // @ts-expect-error -- patching env for test purposes
      c.env = {
        GT_KV: kv,
        QUEUE_EVENTS: queue,
        QUEUE_DISPATCH: queue,
        ENVIRONMENT: 'test',
      };
      await next();
    });

    const eventsRoute = createEventsRoute(insertRawEvent as never);
    app.route('/', eventsRoute);

    return app;
  }

  function makeEventBody(overrides?: Record<string, unknown>) {
    return JSON.stringify({
      event_id: EVENT_ID,
      schema_version: 1,
      launch_public_id: 'launch-public-test-001',
      page_public_id: 'page-public-test-001',
      event_name: 'PageView',
      event_time: EVENT_TIME,
      attribution: {},
      custom_data: {},
      consent: {
        analytics: false,
        marketing: false,
        functional: true,
      },
      ...overrides,
    });
  }

  it('embeds is_test=true in raw payload when X-GT-Test-Mode: 1 header is present', async () => {
    const insertRawEvent = vi.fn().mockResolvedValue(undefined);
    const app = buildEventsApp(insertRawEvent);

    const res = await app.request('/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GT-Test-Mode': '1',
      },
      body: makeEventBody(),
    });

    // Should accept (202)
    expect(res.status).toBe(202);

    // insertRawEvent must have been called with is_test=true in payload
    expect(insertRawEvent).toHaveBeenCalledOnce();
    const callArgs = insertRawEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(callArgs.payload.is_test).toBe(true);
  });

  it('embeds is_test=false in raw payload when X-GT-Test-Mode header is absent', async () => {
    const insertRawEvent = vi.fn().mockResolvedValue(undefined);
    const app = buildEventsApp(insertRawEvent);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: makeEventBody(),
    });

    expect(res.status).toBe(202);

    expect(insertRawEvent).toHaveBeenCalledOnce();
    const callArgs = insertRawEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(callArgs.payload.is_test).toBe(false);
  });

  it('embeds is_test=true when __gt_test=1 cookie is present (no header)', async () => {
    const insertRawEvent = vi.fn().mockResolvedValue(undefined);
    const app = buildEventsApp(insertRawEvent);

    const res = await app.request('/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: '__gt_test=1',
      },
      body: makeEventBody(),
    });

    expect(res.status).toBe(202);

    expect(insertRawEvent).toHaveBeenCalledOnce();
    const callArgs = insertRawEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(callArgs.payload.is_test).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PART 2: raw-events-processor.ts — is_test propagated to events.isTest on INSERT
//
// Tests that when the raw_events.payload contains is_test=true, the processor
// passes isTest=true to the events INSERT, and vice versa for is_test=false.
// ---------------------------------------------------------------------------

describe('raw-events-processor: is_test propagated to events INSERT', () => {
  const RAW_EVENT_ID = 'raw-evt-aaaa-bbbb-cccc';
  const WORKSPACE_ID_PROC = '11111111-1111-1111-1111-111111111111';
  const PAGE_ID_PROC = '22222222-2222-2222-2222-222222222222';

  function makeRawEventRow(isTest: boolean) {
    return {
      id: RAW_EVENT_ID,
      workspaceId: WORKSPACE_ID_PROC,
      pageId: PAGE_ID_PROC,
      processingStatus: 'pending',
      receivedAt: new Date('2026-05-02T12:00:01Z'),
      processedAt: null,
      processingError: null,
      headersSanitized: {},
      payload: {
        event_id: EVENT_ID,
        event_name: 'PageView',
        event_time: EVENT_TIME,
        user_data: {},
        custom_data: {},
        attribution: {},
        consent: {
          analytics: 'unknown',
          marketing: 'unknown',
          ad_user_data: 'unknown',
          ad_personalization: 'unknown',
          customer_match: 'unknown',
        },
        is_test: isTest,
      },
    };
  }

  /**
   * Creates a mock Drizzle Db that:
   *   - Returns the given raw_event row on SELECT
   *   - Captures INSERT values for assertion
   *   - Succeeds on UPDATE (mark processed)
   */
  function makeMockDb(rawEventRow: Record<string, unknown>) {
    const insertedValues: Array<Record<string, unknown>> = [];

    const updateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([rawEventRow]),
          }),
        }),
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          insertedValues.push(vals);
          return {
            returning: vi.fn().mockResolvedValue([{ id: 'evt-inserted-001' }]),
          };
        }),
      })),
      update: updateMock,
    };

    return { db, insertedValues };
  }

  it('events INSERT receives isTest=true when raw payload has is_test=true', async () => {
    const rawRow = makeRawEventRow(true);
    const { db, insertedValues } = makeMockDb(rawRow);

    const result = await processRawEvent(RAW_EVENT_ID, db as never);

    expect(result.ok).toBe(true);

    // First insert call is for the events table
    const eventsInsert = insertedValues[0];
    expect(eventsInsert).toBeDefined();
    expect(eventsInsert!.isTest).toBe(true);
  });

  it('events INSERT receives isTest=false when raw payload has is_test=false', async () => {
    const rawRow = makeRawEventRow(false);
    const { db, insertedValues } = makeMockDb(rawRow);

    const result = await processRawEvent(RAW_EVENT_ID, db as never);

    expect(result.ok).toBe(true);

    const eventsInsert = insertedValues[0];
    expect(eventsInsert).toBeDefined();
    expect(eventsInsert!.isTest).toBe(false);
  });

  it('events INSERT defaults isTest=false when is_test is absent from raw payload', async () => {
    const rawRow = makeRawEventRow(false);
    // Remove is_test from payload to test default
    const payloadWithoutIsTest = { ...(rawRow.payload as Record<string, unknown>) };
    delete payloadWithoutIsTest.is_test;
    const rawRowWithout = { ...rawRow, payload: payloadWithoutIsTest };

    const { db, insertedValues } = makeMockDb(rawRowWithout);

    const result = await processRawEvent(RAW_EVENT_ID, db as never);

    expect(result.ok).toBe(true);

    const eventsInsert = insertedValues[0];
    expect(eventsInsert).toBeDefined();
    // Zod default: is_test absent → false
    expect(eventsInsert!.isTest).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PART 3: RawEventPayloadSchema — is_test field validation
//
// Tests the Zod schema default and type validation for the is_test field.
// ---------------------------------------------------------------------------

describe('RawEventPayloadSchema: is_test field', () => {
  const BASE_PAYLOAD = {
    event_id: 'evt-schema-test-001',
    event_name: 'PageView',
    event_time: '2026-05-02T12:00:00.000Z',
    user_data: {},
    custom_data: {},
    attribution: {},
    consent: {},
  };

  it('defaults is_test to false when absent', () => {
    const result = RawEventPayloadSchema.safeParse(BASE_PAYLOAD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.is_test).toBe(false);
  });

  it('accepts is_test=true', () => {
    const result = RawEventPayloadSchema.safeParse({
      ...BASE_PAYLOAD,
      is_test: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.is_test).toBe(true);
  });

  it('accepts is_test=false explicitly', () => {
    const result = RawEventPayloadSchema.safeParse({
      ...BASE_PAYLOAD,
      is_test: false,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.is_test).toBe(false);
  });

  it('rejects non-boolean is_test value', () => {
    const result = RawEventPayloadSchema.safeParse({
      ...BASE_PAYLOAD,
      is_test: 'yes',
    });
    expect(result.success).toBe(false);
  });
});
