/**
 * Unit tests for Step 9 (Google Ads fanout) in raw-events-processor.ts
 *
 * Tests the dispatch_jobs creation gate for Google Ads:
 *   condition: isCanonicalEvent && ga?.enabled === true
 *              && ga.oauth_token_state === 'connected'
 *              && customer_id present
 *              && conversion_actions[eventName] is a non-empty string
 *
 * BRs applied:
 *   ADR-030: only canonical events fan out to Google Ads (no 'custom:*')
 *   BR-DISPATCH-001: idempotency_key includes destination_subresource
 *   INTERNAL_ONLY_EVENT_NAMES: lead_identify / event_duplicate_accepted → zero jobs
 *
 * T-14-015
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processRawEvent } from '../../../apps/edge/src/lib/raw-events-processor';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any imports that trigger module init
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
  workspaces: { id: 'id' },
  launches: {},
  eq: vi.fn((a: unknown, b: unknown) => ({ _tag: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ _tag: 'and', args })),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
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
  hashPii: vi.fn().mockResolvedValue('abc123hash'),
}));

// Key mock: createDispatchJobs — this is what we assert against
vi.mock('../../../apps/edge/src/lib/dispatch', () => ({
  createDispatchJobs: vi.fn(),
  computeIdempotencyKey: vi.fn().mockResolvedValue('idempotency-key-mock'),
}));

vi.mock('../../../apps/edge/src/middleware/sanitize-logs', () => ({
  safeLog: vi.fn(),
}));

import { createDispatchJobs } from '../../../apps/edge/src/lib/dispatch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LAUNCH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RAW_EVENT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const LEAD_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CUSTOMER_ID = '1234567890';
const CONVERSION_ACTION_PURCHASE = 'customers/1234567890/conversionActions/100';
const EVENT_TIME = '2026-05-06T10:00:00Z';

function makeRawEventRow(payloadOverrides?: Record<string, unknown>) {
  return {
    id: RAW_EVENT_ID,
    workspaceId: WORKSPACE_ID,
    pageId: PAGE_ID,
    processingStatus: 'pending',
    receivedAt: new Date('2026-05-06T10:00:01Z'),
    processedAt: null,
    processingError: null,
    headersSanitized: {},
    payload: {
      event_id: 'evt-step9-001',
      event_name: 'Purchase',
      event_time: EVENT_TIME,
      lead_id: LEAD_ID,
      launch_id: LAUNCH_ID,
      user_data: {},
      custom_data: {},
      attribution: {},
      consent: {
        analytics: 'granted',
        marketing: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
        customer_match: 'granted',
      },
      ...payloadOverrides,
    },
  };
}

/**
 * Builds a DB mock with configurable workspace config for Step 9.
 *
 * select().from().where().limit() — used for:
 *   1. rawEvents lookup
 *   2. pre-insert dedup check (events SELECT)
 *   3. blueprint lookup (launches)
 *
 * db.query.workspaces.findFirst — used by Step 9 to read workspace config.
 */
function makeMockDbStep9(opts: {
  rawEventRow: Record<string, unknown>;
  workspaceConfig?: Record<string, unknown> | null;
  insertEventReturns?: Array<{ id: string }>;
}) {
  const { rawEventRow, workspaceConfig = null, insertEventReturns = [{ id: 'evt-uuid-step9' }] } = opts;

  // Insert chain: 1st call = events (returning), subsequent = leadStages
  let insertCallCount = 0;
  const eventsReturning = vi.fn().mockResolvedValue(insertEventReturns);
  const eventsValues = vi.fn().mockReturnValue({ returning: eventsReturning });
  const leadStagesValues = vi.fn().mockResolvedValue([]);

  const insert = vi.fn(() => {
    insertCallCount++;
    if (insertCallCount === 1) return { values: eventsValues };
    return { values: leadStagesValues };
  });

  // update chain
  const updateSetWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  // select chain:
  // Call 1: rawEvents lookup → [rawEventRow]
  // Call 2: pre-insert dedup check (events SELECT) → [] (no duplicate)
  // Call 3+: blueprint lookup (launches) → []
  let selectCallCount = 0;
  const select = vi.fn(() => {
    selectCallCount++;
    if (selectCallCount === 1) {
      // rawEvents fetch
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([rawEventRow]),
          }),
        }),
      };
    }
    if (selectCallCount === 2) {
      // Pre-insert dedup check (events) — return empty = no duplicate
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
    }
    // Blueprint lookup (launches) — return empty row (no blueprint)
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
  });

  // db.query.workspaces.findFirst — Step 9 workspace config read
  const findFirst = vi.fn().mockResolvedValue(
    workspaceConfig !== null ? { config: workspaceConfig } : null,
  );

  const db = {
    select,
    insert,
    update,
    query: {
      workspaces: {
        findFirst,
      },
    },
  } as unknown as Parameters<typeof processRawEvent>[1];

  return {
    db,
    findFirst,
    insert,
    eventsValues,
    eventsReturning,
    leadStagesValues,
    update,
    updateSet,
    updateSetWhere,
  };
}

/** Workspace config with Google Ads fully connected and Purchase mapped. */
function makeConnectedGaConfig(overrides?: Record<string, unknown>) {
  return {
    integrations: {
      google_ads: {
        enabled: true,
        oauth_token_state: 'connected',
        customer_id: CUSTOMER_ID,
        conversion_actions: {
          Purchase: CONVERSION_ACTION_PURCHASE,
        },
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processRawEvent Step 9 — Google Ads fanout (T-14-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: createDispatchJobs returns two Google Ads jobs
    vi.mocked(createDispatchJobs).mockResolvedValue([
      { id: 'job-ga-conv', destination: 'google_ads_conversion' },
      { id: 'job-ga-enh', destination: 'google_enhancement' },
    ] as ReturnType<typeof createDispatchJobs> extends Promise<infer R> ? R : never);
  });

  // -------------------------------------------------------------------------
  // Fixture 1: connected workspace + Purchase mapped → 2 Google Ads jobs
  // -------------------------------------------------------------------------

  it('T-14-015: connected workspace with Purchase mapped creates google_ads_conversion + google_enhancement jobs', async () => {
    const config = makeConnectedGaConfig();
    const rawRow = makeRawEventRow({ event_name: 'Purchase', event_id: 'evt-ga-purchase-001' });
    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(createDispatchJobs).toHaveBeenCalledOnce();

    const jobInputs = vi.mocked(createDispatchJobs).mock.calls[0]?.[0];
    expect(jobInputs).toBeDefined();
    if (!jobInputs) return;

    const destinations = jobInputs.map((j) => j.destination);
    expect(destinations).toContain('google_ads_conversion');
    expect(destinations).toContain('google_enhancement');

    const convJob = jobInputs.find((j) => j.destination === 'google_ads_conversion');
    expect(convJob).toMatchObject({
      workspace_id: WORKSPACE_ID,
      destination: 'google_ads_conversion',
      destination_account_id: CUSTOMER_ID,
      destination_resource_id: CONVERSION_ACTION_PURCHASE,
      destination_subresource: CONVERSION_ACTION_PURCHASE,
    });

    const enhJob = jobInputs.find((j) => j.destination === 'google_enhancement');
    expect(enhJob).toMatchObject({
      workspace_id: WORKSPACE_ID,
      destination: 'google_enhancement',
      destination_account_id: CUSTOMER_ID,
      destination_resource_id: CONVERSION_ACTION_PURCHASE,
    });

    expect(result.value.dispatch_jobs_created).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Fixture 2: Lead event NOT mapped in conversion_actions → 0 Google Ads jobs
  // -------------------------------------------------------------------------

  it('T-14-015: Lead event not mapped in conversion_actions creates zero Google Ads jobs', async () => {
    // conversion_actions only has Purchase, not Lead
    const config = makeConnectedGaConfig();
    const rawRow = makeRawEventRow({
      event_name: 'Lead',
      event_id: 'evt-lead-nomatch',
      lead_id: undefined, // will trigger resolveLeadByAliases, but we don't need it for dispatch
      email: 'user@example.com',
    });

    // Mock lead-resolver for the Lead event
    const { resolveLeadByAliases } = await import('../../../apps/edge/src/lib/lead-resolver');
    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: { lead_id: LEAD_ID, was_created: false, merge_executed: false, merged_lead_ids: [] },
    });

    vi.mocked(createDispatchJobs).mockResolvedValue([]);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);

    // createDispatchJobs may not have been called (no jobs in inputs)
    // OR was called with empty array (no Google Ads jobs)
    const allJobInputs = vi.mocked(createDispatchJobs).mock.calls.flatMap((c) => c[0] ?? []);
    const googleAdsJobs = allJobInputs.filter(
      (j) => j.destination === 'google_ads_conversion' || j.destination === 'google_enhancement',
    );
    expect(googleAdsJobs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 3: oauth_token_state !== 'connected' (pending) → 0 Google Ads jobs
  // -------------------------------------------------------------------------

  it('T-14-015: oauth_token_state=pending blocks Google Ads jobs even with enabled=true and mapped action', async () => {
    const config = makeConnectedGaConfig({ oauth_token_state: 'pending' });
    const rawRow = makeRawEventRow({ event_name: 'Purchase', event_id: 'evt-ga-pending' });
    vi.mocked(createDispatchJobs).mockResolvedValue([]);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);

    const allJobInputs = vi.mocked(createDispatchJobs).mock.calls.flatMap((c) => c[0] ?? []);
    const googleAdsJobs = allJobInputs.filter(
      (j) => j.destination === 'google_ads_conversion' || j.destination === 'google_enhancement',
    );
    expect(googleAdsJobs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 3b: oauth_token_state='expired' → 0 Google Ads jobs
  // -------------------------------------------------------------------------

  it('T-14-015: oauth_token_state=expired blocks Google Ads jobs', async () => {
    const config = makeConnectedGaConfig({ oauth_token_state: 'expired' });
    const rawRow = makeRawEventRow({ event_name: 'Purchase', event_id: 'evt-ga-expired' });
    vi.mocked(createDispatchJobs).mockResolvedValue([]);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);

    const allJobInputs = vi.mocked(createDispatchJobs).mock.calls.flatMap((c) => c[0] ?? []);
    const googleAdsJobs = allJobInputs.filter(
      (j) => j.destination === 'google_ads_conversion' || j.destination === 'google_enhancement',
    );
    expect(googleAdsJobs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 4: enabled=false → 0 Google Ads jobs
  // -------------------------------------------------------------------------

  it('T-14-015: enabled=false blocks Google Ads jobs even with connected OAuth and mapped action', async () => {
    const config = makeConnectedGaConfig({ enabled: false });
    const rawRow = makeRawEventRow({ event_name: 'Purchase', event_id: 'evt-ga-disabled' });
    vi.mocked(createDispatchJobs).mockResolvedValue([]);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);

    const allJobInputs = vi.mocked(createDispatchJobs).mock.calls.flatMap((c) => c[0] ?? []);
    const googleAdsJobs = allJobInputs.filter(
      (j) => j.destination === 'google_ads_conversion' || j.destination === 'google_enhancement',
    );
    expect(googleAdsJobs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 5: custom:click_buy (custom: prefix) → isCanonicalEvent=false → 0 Google Ads jobs
  // ADR-030: only canonical events fan out to Google Ads
  // -------------------------------------------------------------------------

  it('ADR-030: custom:click_buy is non-canonical — zero Google Ads jobs created', async () => {
    const config = makeConnectedGaConfig({
      conversion_actions: {
        Purchase: CONVERSION_ACTION_PURCHASE,
        'custom:click_buy': 'customers/1234567890/conversionActions/999',
      },
    });
    const rawRow = makeRawEventRow({
      event_name: 'custom:click_buy',
      event_id: 'evt-ga-custom',
    });
    vi.mocked(createDispatchJobs).mockResolvedValue([]);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);

    const allJobInputs = vi.mocked(createDispatchJobs).mock.calls.flatMap((c) => c[0] ?? []);
    const googleAdsJobs = allJobInputs.filter(
      (j) => j.destination === 'google_ads_conversion' || j.destination === 'google_enhancement',
    );
    expect(googleAdsJobs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fixture 6: INTERNAL_ONLY_EVENT_NAMES — lead_identify → Step 9 entirely skipped
  // -------------------------------------------------------------------------

  it('INTERNAL_ONLY_EVENT_NAMES: lead_identify skips Step 9 entirely — zero Google Ads jobs', async () => {
    const config = makeConnectedGaConfig({
      conversion_actions: {
        lead_identify: 'customers/1234567890/conversionActions/888',
        Purchase: CONVERSION_ACTION_PURCHASE,
      },
    });
    // lead_identify is in INTERNAL_ONLY_EVENT_NAMES — dispatch gate is skipped
    const rawRow = makeRawEventRow({
      event_name: 'lead_identify',
      event_id: 'evt-internal-lead-identify',
      lead_id: LEAD_ID,
    });
    vi.mocked(createDispatchJobs).mockResolvedValue([]);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Step 9 is entirely skipped for INTERNAL_ONLY_EVENT_NAMES
    expect(createDispatchJobs).not.toHaveBeenCalled();
    expect(result.value.dispatch_jobs_created).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Bonus: no google_ads config at all → no Google Ads jobs (graceful)
  // -------------------------------------------------------------------------

  it('T-14-015: workspace without google_ads config creates zero Google Ads jobs', async () => {
    const config = {
      integrations: {
        meta: { pixel_id: 'px-001', capi_token: 'tok-001' },
        // No google_ads
      },
    };
    vi.mocked(createDispatchJobs).mockResolvedValue([
      { id: 'job-meta', destination: 'meta_capi' },
    ] as ReturnType<typeof createDispatchJobs> extends Promise<infer R> ? R : never);

    const rawRow = makeRawEventRow({ event_name: 'Purchase', event_id: 'evt-no-ga-config' });
    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    const result = await processRawEvent(RAW_EVENT_ID, db);
    expect(result.ok).toBe(true);

    const allJobInputs = vi.mocked(createDispatchJobs).mock.calls.flatMap((c) => c[0] ?? []);
    const googleAdsJobs = allJobInputs.filter(
      (j) => j.destination === 'google_ads_conversion' || j.destination === 'google_enhancement',
    );
    expect(googleAdsJobs).toHaveLength(0);

    // But meta_capi job should be enqueued
    const metaJobs = allJobInputs.filter((j) => j.destination === 'meta_capi');
    expect(metaJobs).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Bonus: connected workspace + Purchase → correct idempotency via destination_subresource
  // BR-DISPATCH-001: destination_subresource = conversion_action_id
  // -------------------------------------------------------------------------

  it('BR-DISPATCH-001: destination_subresource is set to conversion_action_id for dedup', async () => {
    const config = makeConnectedGaConfig();
    const rawRow = makeRawEventRow({ event_name: 'Purchase', event_id: 'evt-ga-subresource' });
    vi.mocked(createDispatchJobs).mockResolvedValue([
      { id: 'job-conv', destination: 'google_ads_conversion' },
      { id: 'job-enh', destination: 'google_enhancement' },
    ] as ReturnType<typeof createDispatchJobs> extends Promise<infer R> ? R : never);

    const { db } = makeMockDbStep9({ rawEventRow: rawRow, workspaceConfig: config });

    await processRawEvent(RAW_EVENT_ID, db);

    const jobInputs = vi.mocked(createDispatchJobs).mock.calls[0]?.[0] ?? [];
    const convJob = jobInputs.find((j) => j.destination === 'google_ads_conversion');
    expect(convJob?.destination_subresource).toBe(CONVERSION_ACTION_PURCHASE);
  });
});
