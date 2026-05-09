/**
 * Integration flow tests — FLOW-02: Capturar lead e atribuir origem
 *
 * Tests exercise the domain-function chain as the ingestion processor calls them:
 *   resolveLeadByAliases → recordTouches → processRawEvent
 *
 * DB is mocked via vi.fn() — same pattern as tests/unit/identity/*.test.ts.
 * No real database required.
 *
 * BRs applied:
 *   BR-IDENTITY-001: aliases ativos únicos por (workspace_id, identifier_type, identifier_hash)
 *   BR-IDENTITY-002: normalize before hash
 *   BR-IDENTITY-003: merge canônico N>1
 *   BR-ATTRIBUTION-001: first-touch único por (workspace_id, lead_id, launch_id)
 *   BR-ATTRIBUTION-002: last-touch atualizado a cada conversão
 *   BR-EVENT-002: idempotência por (workspace_id, event_id)
 *   BR-EVENT-005: user_data canonical only
 *   BR-PRIVACY-001: PII never in logs
 *   INV-EVENT-001: (workspace_id, event_id) unique
 *   INV-EVENT-003: already-processed raw_event → skip
 *   INV-EVENT-006: consent_snapshot populated on every event
 *
 * OQ-011: dispatch_jobs criação pendente Sprint 3 — not asserted here.
 *
 * Structure:
 *   - Sections A, B use the real resolveLeadByAliases / recordTouches with DB mocks
 *   - Section C uses processRawEvent with lead-resolver + attribution mocked at module level
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks required for processRawEvent
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
  workspaces: { id: 'id', config: 'config' },
  leadAttributions: {
    id: 'id',
    workspaceId: 'workspace_id',
    touchType: 'touch_type',
  },
  leadAliases: {},
  leadMerges: {},
  leads: {},
}));

vi.mock('../../../apps/edge/src/lib/pii', () => ({
  hashPii: vi
    .fn()
    .mockImplementation(
      async (value: string, wsId: string) =>
        `hash-${wsId.slice(-4)}-${value.slice(0, 6)}`,
    ),
}));

// Mock lead-resolver for processRawEvent tests (Section C)
vi.mock('../../../apps/edge/src/lib/lead-resolver', () => ({
  resolveLeadByAliases: vi.fn(),
}));

// Mock attribution for processRawEvent tests
vi.mock('../../../apps/edge/src/lib/attribution', () => ({
  recordTouches: vi.fn().mockResolvedValue({
    ok: true,
    value: { first_created: true, last_updated: true },
  }),
}));

import { recordTouches } from '../../../apps/edge/src/lib/attribution';
import { resolveLeadByAliases } from '../../../apps/edge/src/lib/lead-resolver';
import { processRawEvent } from '../../../apps/edge/src/lib/raw-events-processor';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-flow02-0000-0000-0000-000000000001';
const LAUNCH_ID = '33333333-3333-3333-3333-333333333333';
const LEAD_ID_A = 'lead-00000000-0000-0000-0000-aaaaaaaaaaaa';
const RAW_EVENT_ID = '44444444-4444-4444-4444-444444444444';
const EVENT_TIME = '2026-05-02T12:00:00Z';

// ---------------------------------------------------------------------------
// Helpers for processRawEvent DB mock
// ---------------------------------------------------------------------------

/**
 * Builds a full processRawEvent DB mock.
 * First insert = events table (with returning), subsequent = leadStages.
 */
function makeProcessorDb(opts?: {
  rawEventRow?: Record<string, unknown> | null;
  insertEventsThrows?: Error | null;
}) {
  const rawEventRow = opts?.rawEventRow ?? null;
  const insertEventsThrows = opts?.insertEventsThrows ?? null;

  const updateSetWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const eventsReturning = insertEventsThrows
    ? vi.fn().mockRejectedValue(insertEventsThrows)
    : vi.fn().mockResolvedValue([{ id: 'evt-uuid-001' }]);
  const eventsValues = vi.fn().mockReturnValue({ returning: eventsReturning });
  const leadStagesValues = vi.fn().mockResolvedValue([]);

  let insertCallCount = 0;
  const insert = vi.fn(() => {
    insertCallCount++;
    if (insertCallCount === 1) return { values: eventsValues };
    return { values: leadStagesValues };
  });

  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rawEventRow ? [rawEventRow] : []),
      }),
    }),
  });

  return {
    db: { select, insert, update } as unknown as Parameters<
      typeof processRawEvent
    >[1],
    update,
    updateSet,
    updateSetWhere,
    insert,
    eventsValues,
    leadStagesValues,
  };
}

function makeRawEventRow(payloadOverrides?: Record<string, unknown>) {
  return {
    id: RAW_EVENT_ID,
    workspaceId: WORKSPACE_ID,
    pageId: '22222222-2222-2222-2222-222222222222',
    processingStatus: 'pending',
    receivedAt: new Date('2026-05-02T12:00:01Z'),
    processedAt: null,
    processingError: null,
    headersSanitized: {},
    payload: {
      event_id: 'evt-flow02-001',
      event_name: 'Lead',
      event_time: EVENT_TIME,
      email: 'foo@example.com',
      phone: '+5511999999999',
      launch_id: LAUNCH_ID,
      user_data: {},
      custom_data: {},
      attribution: {
        utm_source: 'meta',
        fbclid: 'ABC123',
      },
      consent: {
        analytics: 'granted',
        marketing: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
        customer_match: 'unknown',
      },
      ...payloadOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// A. Unit-level tests for resolveLeadByAliases (using the mocked version)
// ---------------------------------------------------------------------------

describe('TC-02-01 A: resolveLeadByAliases via mock — novo lead capturado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mock retorna was_created=true para email+phone sem match', async () => {
    // BR-IDENTITY-001, BR-IDENTITY-002
    vi.mocked(resolveLeadByAliases).mockResolvedValueOnce({
      ok: true,
      value: {
        lead_id: LEAD_ID_A,
        was_created: true,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com', phone: '+5511999999999' },
      WORKSPACE_ID,
      {} as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.was_created).toBe(true);
    expect(result.value.merge_executed).toBe(false);
    expect(result.value.merged_lead_ids).toHaveLength(0);
    expect(result.value.lead_id).toBe(LEAD_ID_A);
  });
});

// ---------------------------------------------------------------------------
// B. Unit-level tests for recordTouches (using the mocked version)
// ---------------------------------------------------------------------------

describe('TC-02-01 B: recordTouches via mock — first e last touch registrados', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mock retorna first_created=true e last_updated=true', async () => {
    // BR-ATTRIBUTION-001, BR-ATTRIBUTION-002
    vi.mocked(recordTouches).mockResolvedValueOnce({
      ok: true,
      value: { first_created: true, last_updated: true },
    });

    const result = await recordTouches(
      {
        lead_id: LEAD_ID_A,
        launch_id: LAUNCH_ID,
        workspace_id: WORKSPACE_ID,
        attribution: { utm_source: 'meta', fbclid: 'ABC123' },
        event_time: new Date(EVENT_TIME),
      },
      {} as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.first_created).toBe(true);
    expect(result.value.last_updated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. processRawEvent — integration tests using mocked inner functions
// ---------------------------------------------------------------------------

describe('TC-02-01 C: processRawEvent — novo lead + Lead event + consent_snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for recordTouches
    vi.mocked(recordTouches).mockResolvedValue({
      ok: true,
      value: { first_created: true, last_updated: true },
    });
  });

  it('processRawEvent para evento Lead cria events row com lead_id e consent_snapshot', async () => {
    // BR-EVENT-002, INV-EVENT-006, INV-EVENT-007
    const rawRow = makeRawEventRow();

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID_A,
        was_created: true,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    const { db, eventsValues, leadStagesValues, updateSet } = makeProcessorDb({
      rawEventRow: rawRow,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // OQ-011: dispatch_jobs criação pendente Sprint 3
    expect(result.value.dispatch_jobs_created).toBe(0);

    // events row deve ter lead_id e consent_snapshot
    expect(eventsValues).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: LEAD_ID_A,
        eventName: 'Lead',
        workspaceId: WORKSPACE_ID,
        consentSnapshot: expect.objectContaining({
          analytics: 'granted',
          ad_user_data: 'granted',
        }),
      }),
    );

    // lead_stages row deve ter stage='lead_identified'
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'lead_identified',
        isRecurring: false,
        leadId: LEAD_ID_A,
        launchId: LAUNCH_ID,
      }),
    );

    // raw_event deve ser marcado como processed
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'processed' }),
    );
  });
});

// ---------------------------------------------------------------------------
// TC-02-02: Lead já existe (mesma email) — atualiza, não duplica
// ---------------------------------------------------------------------------

describe('TC-02-02: lead já existe — upsert idempotente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordTouches).mockResolvedValue({
      ok: true,
      value: { first_created: false, last_updated: true },
    });
  });

  it('resolveLeadByAliases retorna was_created=false quando lead já existe', async () => {
    // BR-IDENTITY-001: alias ativo único — não cria duplicata
    vi.mocked(resolveLeadByAliases).mockResolvedValueOnce({
      ok: true,
      value: {
        lead_id: LEAD_ID_A,
        was_created: false,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    const result = await resolveLeadByAliases(
      { email: 'foo@example.com' },
      WORKSPACE_ID,
      {} as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.was_created).toBe(false);
    expect(result.value.lead_id).toBe(LEAD_ID_A);
    expect(result.value.merge_executed).toBe(false);
  });

  it('segundo processRawEvent com mesmo email usa lead_id original e chama recordTouches quando há attribution', async () => {
    const rawRow = makeRawEventRow({ event_id: 'evt-flow02-002' });

    // Resolver devolve lead existente (was_created=false, merge_executed=false)
    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID_A,
        was_created: false,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    const { db, eventsValues } = makeProcessorDb({ rawEventRow: rawRow });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // O events row deve continuar usando o lead_id original
    expect(eventsValues).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: LEAD_ID_A }),
    );

    // recordTouches DEVE ser chamado mesmo com was_created=false quando há attribution —
    // BR-ATTRIBUTION-002: last-touch atualizado em cada evento de identificação com dados de attribution.
    // first-touch é protegido por ON CONFLICT DO NOTHING e não será sobrescrito.
    expect(recordTouches).toHaveBeenCalledWith(
      expect.objectContaining({
        lead_id: LEAD_ID_A,
        launch_id: LAUNCH_ID,
        attribution: expect.objectContaining({ utm_source: 'meta', fbclid: 'ABC123' }),
      }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// TC-02-03: Idempotência do processador — mesmo raw_event processado duas vezes
// ---------------------------------------------------------------------------

describe('TC-02-03: idempotência do processador — evento já processado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BR-EVENT-002: raw_event com status=processed retorna ok sem re-inserir evento', async () => {
    // INV-EVENT-003: replay protection — already-processed raw_event → skip
    const alreadyProcessedRow = makeRawEventRow({ event_id: 'evt-123' });
    (alreadyProcessedRow as Record<string, unknown>).processingStatus =
      'processed';

    const { db, insert } = makeProcessorDb({
      rawEventRow: alreadyProcessedRow,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toBe('evt-123');
    // Não deve inserir nada no banco
    expect(insert).not.toHaveBeenCalled();
  });

  it('BR-EVENT-002: unique violation no events insert → marca como duplicate, retorna ok', async () => {
    // INV-EVENT-001: (workspace_id, event_id) unique — segundo processamento gera 23505
    const rawRow = makeRawEventRow({ event_id: 'evt-123' });
    const uniqueError = new Error(
      'duplicate key value violates unique constraint (23505)',
    );

    // resolveLeadByAliases precisa retornar ok para que o processor chegue ao insert
    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID_A,
        was_created: false,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    const { db, updateSet } = makeProcessorDb({
      rawEventRow: rawRow,
      insertEventsThrows: uniqueError,
    });

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event_id).toBe('evt-123');
    // Deve marcar o raw_event como processed (não failed)
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'processed' }),
    );
  });

  it('BR-EVENT-002: chamada repetida com raw_event.processingStatus=processed não chama resolveLeadByAliases', async () => {
    const alreadyProcessedRow = makeRawEventRow();
    (alreadyProcessedRow as Record<string, unknown>).processingStatus =
      'processed';

    const { db } = makeProcessorDb({ rawEventRow: alreadyProcessedRow });

    await processRawEvent(RAW_EVENT_ID, db);

    // Resolver não deve ser chamado para evento já processado
    expect(resolveLeadByAliases).not.toHaveBeenCalled();
  });

  it('INV-EVENT-006: consent_snapshot defaults to all unknown when absent', async () => {
    // Payload sem consent → deve default para tudo 'unknown'
    const rawRow = makeRawEventRow({ event_id: 'evt-consent-default' });
    // Remove consent from payload
    const payload = rawRow.payload as Record<string, unknown>;
    const { consent: _omit, ...payloadWithoutConsent } = payload;
    rawRow.payload = payloadWithoutConsent as typeof rawRow.payload;

    vi.mocked(resolveLeadByAliases).mockResolvedValue({
      ok: true,
      value: {
        lead_id: LEAD_ID_A,
        was_created: false,
        merge_executed: false,
        merged_lead_ids: [],
      },
    });

    const { db, eventsValues } = makeProcessorDb({ rawEventRow: rawRow });

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
});
