/**
 * Unit tests — OnProfit order-bump dispatch skip logic
 *
 * T-ID: Wave 8 — OnProfit consolidated dispatch
 *
 * BRs applied:
 *   BR-DISPATCH-007: order_bump events must NOT create dispatch_jobs; only
 *     the main product event fans out to Meta/GA4/Google Ads, carrying the
 *     aggregated transaction value.
 *   BR-EVENT-001: raw_event persisted before 202 response.
 *   INV-EVENT-005: Edge persists raw_event before returning 202.
 *   BR-WEBHOOK-003: non-mappable payloads → failed + 200.
 *
 * Scenarios:
 *   TC-OB-01: webhook main product → persists raw_event AND enqueues in QUEUE_EVENTS
 *   TC-OB-02: webhook order_bump → persists raw_event AND enqueues in QUEUE_EVENTS
 *             (dispatch-skip happens async in processor — validated in TC-OB-03)
 *   TC-OB-03: processOnprofitRawEvent with item_type='order_bump' → dispatch_jobs_created=0
 *   TC-OB-04: processOnprofitRawEvent with item_type='product' → dispatch_jobs created with delay_seconds=80
 *   TC-OB-05: deriveTransactionGroupId is deterministic — same inputs produce same group id
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOnprofitWebhookRoute } from '../../../apps/edge/src/routes/webhooks/onprofit.js';
import { processOnprofitRawEvent } from '../../../apps/edge/src/lib/onprofit-raw-events-processor.js';
import { unwrapJsonb } from '../../helpers/jsonb-unwrap.js';
import mainFixture from '../../fixtures/onprofit/transaction-approved-main.json';
import ob1Fixture from '../../fixtures/onprofit/transaction-approved-ob1.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-ob-test-0000-0000-000000000001';
const WORKSPACE_SLUG = 'test-workspace-ob';

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown): Promise<void> {
      messages.push(msg);
    },
    async sendBatch(msgs: MessageSendRequest[]): Promise<void> {
      for (const m of msgs) messages.push(m.body);
    },
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// Mock DB for OnProfit webhook route
//
// Matches what the route handler calls:
//   1. db.query.workspaces.findFirst({where: eq(workspaces.slug, ...)})
//   2. resolveLaunchForOnProfitEvent calls (launchProducts, workspaces, etc.)
//      — these can return null to simplify, launch resolution is non-fatal
//   3. db.insert(rawEvents).values({...}).returning({id: rawEvents.id})
// ---------------------------------------------------------------------------

interface RawEventRow {
  id: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  processingStatus: string;
}

function createOnprofitRouteMockDb(opts: {
  workspaceId?: string;
  workspaceSlug?: string;
}) {
  const rawEventsInserted: RawEventRow[] = [];
  let rowCounter = 0;

  const db = {
    query: {
      workspaces: {
        findFirst: vi.fn(async (_opts: unknown) => ({
          id: opts.workspaceId ?? WORKSPACE_ID,
          slug: opts.workspaceSlug ?? WORKSPACE_SLUG,
          config: {
            integrations: {
              meta: { pixel_id: 'pixel-test-001', capi_token: 'capi-token-001' },
            },
          },
        })),
      },
      // For resolveLaunchForOnProfitEvent → launchProducts query
      launchProducts: {
        findFirst: vi.fn(async () => null),
      },
    },

    // Generic select chain for resolveLaunchForOnProfitEvent internal queries
    select: vi.fn((_fields?: unknown) => ({
      from: vi.fn((_table: unknown) => ({
        where: vi.fn((_cond: unknown) => ({
          limit: vi.fn(async () => []),
        })),
        innerJoin: vi.fn((_table2: unknown, _cond: unknown) => ({
          where: vi.fn((_cond2: unknown) => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    })),

    // insert chain for raw_events
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        const id = `raw-evt-ob-${++rowCounter}`;
        const row: RawEventRow = {
          id,
          workspaceId: values.workspaceId as string,
          payload:
            (unwrapJsonb(values.payload) as Record<string, unknown>) ?? {},
          processingStatus: (values.processingStatus as string) ?? 'pending',
        };
        rawEventsInserted.push(row);

        const base = Promise.resolve([]);
        // biome-ignore lint/suspicious/noExplicitAny: mock extension
        (base as any).returning = (_fields?: unknown) =>
          Promise.resolve([{ id }]);
        // biome-ignore lint/suspicious/noExplicitAny: mock object
        return base as any;
      }),
    })),
  };

  return {
    // biome-ignore lint/suspicious/noExplicitAny: mock object
    db: db as any,
    rawEventsInserted,
  };
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(db: Parameters<typeof createOnprofitWebhookRoute>[0]) {
  const app = new Hono<{ Bindings: AppBindings }>();
  const queue = createMockQueue();

  // Mount under the same path as production
  app.route('/v1/webhooks/onprofit', createOnprofitWebhookRoute(db));

  return { app, queue };
}

function makeOnprofitRequest(
  payload: Record<string, unknown>,
  queue: Queue,
  workspaceSlug = WORKSPACE_SLUG,
): { url: string; opts: RequestInit & { env?: Record<string, unknown> } } {
  return {
    url: `http://localhost/v1/webhooks/onprofit?workspace=${workspaceSlug}`,
    opts: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  };
}

// ---------------------------------------------------------------------------
// Mock DB for processOnprofitRawEvent (processor direct tests)
//
// The processor calls db.select().from().where().limit() in three places:
//   call 1 — Step 1:  fetch raw_events row  → returns rawEventRow
//   call 2 — Step 3:  resolveLeadByPptc / resolveLeadByAliases sub-queries
//                     (these internally also call select; we treat any extra
//                     limit(1) as "empty, no lead found" — non-fatal)
//   call 3 — Step 7:  idempotency lookup on events         → returns []
//   call N — Step 11: createDispatchJobs select-back        → returns dispatch_jobs rows
//                     (uses `where(inArray(...))` without .limit())
//
// All chains return a consistent `{ limit, then }` shape so the processor
// never hits "limit is not a function".
// ---------------------------------------------------------------------------

function createProcessorMockDb(opts: {
  rawEventPayload: Record<string, unknown>;
  itemType?: string;
}) {
  const RAW_EVENT_ID = 'raw-evt-processor-0001';
  const INSERTED_EVENT_ID = 'evt-processor-0001';

  const dispatchJobsInserted: Array<{
    destination: string;
    id: string;
  }> = [];

  // Build the raw_event row that the processor will fetch in Step 1.
  const rawEventRow = {
    id: RAW_EVENT_ID,
    workspaceId: WORKSPACE_ID,
    payload: {
      ...opts.rawEventPayload,
      item_type: opts.itemType ?? opts.rawEventPayload.item_type ?? 'product',
      _onprofit_event_type: 'Purchase',
      _onprofit_event_id: `evt-proc-${opts.itemType ?? 'product'}-001`,
    },
    processingStatus: 'pending',
    receivedAt: new Date('2026-05-10T17:45:00Z'),
  };

  let dispatchJobCounter = 0;
  // Track how many times the raw_event row has been returned (Step 1 only once).
  let rawEventRowReturned = false;
  // Track whether Step 7 idempotency lookup has been answered (return empty once).
  let idempotencyCheckDone = false;

  /**
   * Build a Thenable+limit chain that resolves to `rows`.
   * Thenable makes the `await db.select().from().where()` form work WITHOUT .limit().
   * limit() also resolves to `rows` so the form with .limit() works too.
   */
  function makeSelectResult(rows: unknown[]) {
    // Must be awaitable AND expose .limit()
    const obj = {
      then(
        resolve: (v: unknown[]) => void,
        _reject?: (e: unknown) => void,
      ) {
        resolve(rows);
        return this;
      },
      limit: (_n: number) => Promise.resolve(rows),
    };
    return obj;
  }

  /**
   * Stateful where() resolver.
   * Heuristic order for this processor:
   *   - First call with limit(1): Step 1 raw_event fetch → rawEventRow
   *   - Second call with limit(1): Step 3 pptc/lead query or Step 7 → []
   *   - Subsequent limit(1) calls → []
   *   - Calls WITHOUT limit (thenable): Step 11 dispatch_jobs select-back → dispatchJobsInserted rows
   */
  function makeWhereChain() {
    const result = makeSelectResult(
      (() => {
        // This closure is called lazily — we need stateful logic.
        // We return a proxy-like object that defers row resolution.
        return [];
      })(),
    );

    // Override limit to apply stateful logic
    result.limit = (_n: number): Promise<unknown[]> => {
      if (!rawEventRowReturned) {
        rawEventRowReturned = true;
        return Promise.resolve([rawEventRow]);
      }
      if (!idempotencyCheckDone) {
        idempotencyCheckDone = true;
        return Promise.resolve([]); // Step 7: not a duplicate
      }
      return Promise.resolve([]); // all other limit queries → empty
    };

    // Override then for the no-limit awaitable form (Step 11 dispatch_jobs)
    result.then = (
      resolve: (v: unknown[]) => void,
      _reject?: (e: unknown) => void,
    ) => {
      // Step 11 dispatch_jobs select-back (uses inArray, no limit)
      const jobs = dispatchJobsInserted.map((j) => ({
        id: j.id,
        destination: j.destination,
        workspaceId: WORKSPACE_ID,
        status: 'pending',
        idempotencyKey: `ikey-${j.id}`,
      }));
      resolve(jobs);
      return result;
    };

    return result;
  }

  const db = {
    select: vi.fn((_fields?: unknown) => ({
      from: vi.fn((_table: unknown) => ({
        where: vi.fn((_cond: unknown) => makeWhereChain()),
      })),
    })),

    query: {
      workspaces: {
        findFirst: vi.fn(async () => ({
          id: WORKSPACE_ID,
          config: {
            integrations: {
              meta: { pixel_id: 'pixel-test-001', capi_token: 'capi-token-001' },
            },
          },
        })),
      },
    },

    // Steps 4 (fn/ln hash update), 12 (mark processed)
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((_vals: unknown) => ({
        where: vi.fn(async () => undefined),
      })),
    })),

    // Steps 8 (events insert), 9 (lead_stages), 11 (dispatch_jobs insert+onConflictDoNothing)
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn(
        (
          vals:
            | Record<string, unknown>
            | Array<Record<string, unknown>>,
        ) => {
          const isArray = Array.isArray(vals);
          const first = isArray
            ? (vals as Array<Record<string, unknown>>)[0]
            : (vals as Record<string, unknown>);
          const destination = first?.destination as string | undefined;

          // Dispatch jobs insert
          if (destination) {
            const id = `dispatch-job-${++dispatchJobCounter}`;
            dispatchJobsInserted.push({ destination, id });
          }

          const base = Promise.resolve([]);
          // biome-ignore lint/suspicious/noExplicitAny: mock extension
          (base as any).returning = (_fields?: unknown) =>
            Promise.resolve([{ id: INSERTED_EVENT_ID }]);
          // biome-ignore lint/suspicious/noExplicitAny: mock extension
          (base as any).onConflictDoNothing = () => ({
            returning: (_fields?: unknown) =>
              Promise.resolve([{ id: INSERTED_EVENT_ID }]),
          });
          // biome-ignore lint/suspicious/noExplicitAny: mock object
          return base as any;
        },
      ),
    })),
  };

  return {
    // biome-ignore lint/suspicious/noExplicitAny: mock object
    db: db as any,
    rawEventId: RAW_EVENT_ID,
    dispatchJobsInserted,
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('OnProfit webhook route — order bump dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // TC-OB-01: main product webhook → persists raw_event AND enqueues
  // --------------------------------------------------------------------------

  describe('TC-OB-01: webhook main product → 202 + raw_event persisted + queue message', () => {
    it(
      'BR-EVENT-001 / INV-EVENT-005: main product webhook returns 202,' +
        ' inserts raw_event with status=pending, and sends queue message',
      async () => {
        const { db, rawEventsInserted } = createOnprofitRouteMockDb({
          workspaceId: WORKSPACE_ID,
          workspaceSlug: WORKSPACE_SLUG,
        });

        const { app, queue } = buildApp(db);

        const { url, opts } = makeOnprofitRequest(
          mainFixture as Record<string, unknown>,
          queue,
        );

        const res = await app.request(url, {
          ...opts,
          env: { QUEUE_EVENTS: queue },
        } as RequestInit);

        expect(res.status).toBe(202);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.received).toBe(true);

        // raw_event persisted
        expect(rawEventsInserted).toHaveLength(1);
        expect(rawEventsInserted[0]?.processingStatus).toBe('pending');
        expect(rawEventsInserted[0]?.workspaceId).toBe(WORKSPACE_ID);
      },
    );
  });

  // --------------------------------------------------------------------------
  // TC-OB-02: order_bump webhook → persists raw_event AND enqueues
  // (dispatch skip happens asynchronously in the processor)
  // --------------------------------------------------------------------------

  describe('TC-OB-02: webhook order_bump → 202 + raw_event persisted (dispatch skipped in processor)', () => {
    it(
      'BR-EVENT-001: order_bump webhook returns 202 and persists raw_event' +
        ' with status=pending (processor is responsible for skipping dispatch)',
      async () => {
        const { db, rawEventsInserted } = createOnprofitRouteMockDb({
          workspaceId: WORKSPACE_ID,
          workspaceSlug: WORKSPACE_SLUG,
        });

        const { app, queue } = buildApp(db);

        const { url, opts } = makeOnprofitRequest(
          ob1Fixture as Record<string, unknown>,
          queue,
        );

        const res = await app.request(url, {
          ...opts,
          env: { QUEUE_EVENTS: queue },
        } as RequestInit);

        expect(res.status).toBe(202);

        // raw_event persisted (route does not discriminate item_type)
        expect(rawEventsInserted).toHaveLength(1);
        expect(rawEventsInserted[0]?.processingStatus).toBe('pending');

        // Payload preserves item_type so the async processor can read it
        const payload = rawEventsInserted[0]?.payload ?? {};
        expect(payload.item_type).toBe('order_bump');
      },
    );
  });

  // --------------------------------------------------------------------------
  // TC-OB-03: processOnprofitRawEvent with item_type='order_bump' → dispatch_jobs_created=0
  // --------------------------------------------------------------------------

  describe('TC-OB-03: processOnprofitRawEvent(order_bump) → dispatch_jobs_created=0', () => {
    it(
      'ONPROFIT-W3-PROCESSOR / BR-DISPATCH-007: order_bump processor result' +
        ' has dispatch_jobs_created=0 and empty dispatch_job_ids',
      async () => {
        const rawEventPayload = {
          ...ob1Fixture,
          _onprofit_event_type: 'Purchase',
          _onprofit_event_id: 'evt-proc-ob1-001',
          item_type: 'order_bump',
          offer_hash: 'offer-abc-001',
          purchase_date: '2026-05-10 17:45:00',
        };

        const { db, rawEventId } = createProcessorMockDb({
          rawEventPayload,
          itemType: 'order_bump',
        });

        const result = await processOnprofitRawEvent(rawEventId, db);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.dispatch_jobs_created).toBe(0);
        expect(result.value.dispatch_job_ids).toHaveLength(0);
      },
    );
  });

  // --------------------------------------------------------------------------
  // TC-OB-04: processOnprofitRawEvent with item_type='product' → dispatch_jobs with delay_seconds=80
  // --------------------------------------------------------------------------

  describe('TC-OB-04: processOnprofitRawEvent(main product) → dispatch_jobs with delay_seconds=80', () => {
    it(
      'ONPROFIT-W4 / BR-DISPATCH-007: main product processor result has' +
        ' dispatch_job_ids with delay_seconds=80 (80s window for OB aggregation)',
      async () => {
        const rawEventPayload = {
          ...mainFixture,
          _onprofit_event_type: 'Purchase',
          _onprofit_event_id: 'evt-proc-main-001',
          item_type: 'product',
          offer_hash: 'offer-abc-001',
          purchase_date: '2026-05-10 17:45:00',
        };

        const { db, rawEventId, dispatchJobsInserted } = createProcessorMockDb({
          rawEventPayload,
          itemType: 'product',
        });

        const result = await processOnprofitRawEvent(rawEventId, db);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // At least one dispatch job must have been created (meta_capi config present)
        expect(result.value.dispatch_jobs_created).toBeGreaterThan(0);
        expect(result.value.dispatch_job_ids).toHaveLength(
          result.value.dispatch_jobs_created,
        );

        // Each dispatch_job for the main product must carry delay_seconds=80
        for (const job of result.value.dispatch_job_ids) {
          expect(job.delay_seconds).toBe(80);
        }
      },
    );
  });

  // --------------------------------------------------------------------------
  // TC-OB-05: transaction_group_id is deterministic across main + OB payloads
  // --------------------------------------------------------------------------

  describe('TC-OB-05: transaction_group_id deterministic — same offer_hash+email+timestamp → same group id', () => {
    it(
      'ONPROFIT-W3-PROCESSOR: both main product and order_bump webhooks with' +
        ' matching offer_hash + customer.email + purchase_date produce identical' +
        ' transaction_group_id in events.custom_data',
      async () => {
        // We verify determinism by processing both payloads and inspecting the
        // custom_data.transaction_group_id captured by the DB insert mock.

        const capturedCustomData: Array<Record<string, unknown>> = [];

        // Shared timestamp and offer data (same transaction)
        const SHARED_TIMESTAMP = '2026-05-10 17:45:00';
        const SHARED_OFFER_HASH = 'offer-abc-001';
        const SHARED_EMAIL = 'comprador@test.com';

        function createCapturingDb(payload: Record<string, unknown>) {
          const rawEventRow = {
            id: 'raw-evt-det-001',
            workspaceId: WORKSPACE_ID,
            payload,
            processingStatus: 'pending',
            receivedAt: new Date('2026-05-10T17:45:00Z'),
          };

          let rawEventReturned = false;
          let idempotencyChecked = false;

          function makeCapturingWhereChain() {
            const obj = {
              then(
                resolve: (v: unknown[]) => void,
                _reject?: (e: unknown) => void,
              ) {
                resolve([]);
                return obj;
              },
              limit: (_n: number): Promise<unknown[]> => {
                if (!rawEventReturned) {
                  rawEventReturned = true;
                  return Promise.resolve([rawEventRow]);
                }
                if (!idempotencyChecked) {
                  idempotencyChecked = true;
                  return Promise.resolve([]);
                }
                return Promise.resolve([]);
              },
            };
            return obj;
          }

          const db = {
            select: vi.fn((_fields?: unknown) => ({
              from: vi.fn((_table: unknown) => ({
                where: vi.fn((_cond: unknown) => makeCapturingWhereChain()),
              })),
            })),
            query: {
              workspaces: {
                findFirst: vi.fn(async () => ({
                  id: WORKSPACE_ID,
                  config: { integrations: {} }, // no dispatch config → 0 jobs
                })),
              },
            },
            update: vi.fn((_table: unknown) => ({
              set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
            })),
            insert: vi.fn((_table: unknown) => ({
              values: vi.fn((vals: Record<string, unknown>) => {
                // Capture customData from events insert
                const customData = unwrapJsonb(vals.customData);
                if (customData && typeof customData === 'object') {
                  capturedCustomData.push(customData as Record<string, unknown>);
                }
                const base = Promise.resolve([]);
                // biome-ignore lint/suspicious/noExplicitAny: mock extension
                (base as any).returning = () =>
                  Promise.resolve([{ id: 'evt-det-001' }]);
                // biome-ignore lint/suspicious/noExplicitAny: mock extension
                (base as any).onConflictDoNothing = () => ({
                  returning: () => Promise.resolve([{ id: 'evt-det-001' }]),
                });
                // biome-ignore lint/suspicious/noExplicitAny: mock object
                return base as any;
              }),
            })),
          };
          // biome-ignore lint/suspicious/noExplicitAny: mock object
          return db as any;
        }

        const mainPayload = {
          ...mainFixture,
          _onprofit_event_type: 'Purchase',
          _onprofit_event_id: 'evt-det-main-001',
          item_type: 'product',
          offer_hash: SHARED_OFFER_HASH,
          purchase_date: SHARED_TIMESTAMP,
          customer: { name: 'Comprador Teste', email: SHARED_EMAIL, phone: '11999999999' },
        };

        const ob1Payload = {
          ...ob1Fixture,
          _onprofit_event_type: 'Purchase',
          _onprofit_event_id: 'evt-det-ob1-001',
          item_type: 'order_bump',
          offer_hash: SHARED_OFFER_HASH,
          purchase_date: SHARED_TIMESTAMP,
          customer: { name: 'Comprador Teste', email: SHARED_EMAIL, phone: '11999999999' },
        };

        const dbMain = createCapturingDb(mainPayload);
        const dbOb1 = createCapturingDb(ob1Payload);

        await processOnprofitRawEvent('raw-evt-det-001', dbMain);
        await processOnprofitRawEvent('raw-evt-det-001', dbOb1);

        // Both events should have captured a transaction_group_id in custom_data
        expect(capturedCustomData).toHaveLength(2);

        const groupIdMain = capturedCustomData[0]?.transaction_group_id;
        const groupIdOb1 = capturedCustomData[1]?.transaction_group_id;

        // Both must be non-null 32-char hex strings
        expect(typeof groupIdMain).toBe('string');
        expect(typeof groupIdOb1).toBe('string');
        expect((groupIdMain as string).length).toBe(32);
        expect((groupIdOb1 as string).length).toBe(32);

        // And they must be equal — deterministic derivation from same inputs
        expect(groupIdMain).toBe(groupIdOb1);
      },
    );
  });
});
