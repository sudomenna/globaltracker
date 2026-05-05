/**
 * Integration tests — Paid Workshop v2 funnel template: custom event matching
 *
 * T-ID: T-FUNIL-033 (Sprint 12, Onda 2)
 *
 * Cobertura: pipeline raw_event → processor → lead_stages para o template
 * `lancamento_pago_workshop_com_main_offer` v2 (migration 0031).
 *
 * Cenários (5 testes mínimos):
 *   1. `custom:click_buy_workshop`  → stage='clicked_buy_workshop',  is_recurring=true
 *   2. `custom:survey_responded`    → stage='survey_responded',      is_recurring=false
 *   3. `custom:watched_workshop`    → stage='watched_workshop',      is_recurring=false
 *   4. `custom:click_buy_main`      → stage='clicked_buy_main',      is_recurring=true
 *   5. Custom event não mapeado (`custom:foo_bar`) → NÃO cria stage (zero inserts em lead_stages)
 *
 * Estratégia: hermetic mock do Db (sem Postgres). Reusa mocks padrão usados em
 * tests/unit/event/raw-events-processor.test.ts:
 *   - vi.mock('@globaltracker/db') — tabelas como objetos opacos.
 *   - First db.select() retorna o raw_events row.
 *   - Second db.select() retorna o funnel_blueprint v2 (subset com 4 stages relevantes).
 *   - db.insert() — primeira chamada = events (com .returning), demais = lead_stages.
 *   - blueprintCache.clear() entre testes para garantir miss → fetch.
 *
 * BRs aplicáveis:
 *   BR-EVENT-001: matching exato por event_name preservando prefixo `custom:`
 *                 (raw-events-processor.ts:330 — stage.source_events.includes(eventName)).
 *   BR-PRIVACY-001: nenhum PII em payload de teste (apenas slug descriptors).
 *   INV-FUNNEL-001..004: stage slug não-vazio, ≤64 chars, blueprint Zod-valid.
 *
 * Determinismo: timestamps fixos em fixture; sem Date.now()/Math.random().
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blueprintCache,
  processRawEvent,
} from '../../../../apps/edge/src/lib/raw-events-processor';

// ---------------------------------------------------------------------------
// Mocks (mesmas dependências do processor unit test)
// ---------------------------------------------------------------------------

// Mock @globaltracker/db — tabelas são objetos opacos; processor importa
// referências para passar a Drizzle insert/select que retornam mocks.
vi.mock('@globaltracker/db', () => ({
  events: { id: 'id', workspaceId: 'workspace_id', eventId: 'event_id' },
  leadStages: {},
  rawEvents: {},
  launches: {},
}));

// Lead resolver não é exercitado nesses testes (lead_id já vem pré-resolvido
// no payload — Edge resolve via lead_token e injeta antes de inserir o raw_event).
vi.mock('../../../../apps/edge/src/lib/lead-resolver', () => ({
  resolveLeadByAliases: vi.fn(),
}));

vi.mock('../../../../apps/edge/src/lib/attribution', () => ({
  recordTouches: vi.fn().mockResolvedValue({
    ok: true,
    value: { first_created: false, last_updated: false },
  }),
}));

vi.mock('../../../../apps/edge/src/lib/pii', () => ({
  hashPii: vi.fn().mockResolvedValue('hash:test'),
}));

// ---------------------------------------------------------------------------
// Fixtures determinísticas (sem PII)
// ---------------------------------------------------------------------------

const WORKSPACE_ID = '74860330-a528-4951-bf49-90f0b5c72521'; // wkshop-cs-jun26 workspace
const LAUNCH_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // launch UUID estável p/ blueprint cache
const RAW_EVENT_ID = '11111111-2222-3333-4444-555555555555';
const LEAD_ID = '99999999-8888-7777-6666-555555555555';
const PAGE_ID = '22222222-3333-4444-5555-666666666666';
const EVENT_TIME = '2026-05-04T12:00:00.000Z';

/**
 * Subset relevante do blueprint v2 (migration 0031). Inclui APENAS os 4 stages
 * dependentes de custom events, mais um stage de Lead canônico para validar que
 * eventos não-custom não interferem nos custom. Forma alinhada com FunnelBlueprintSchema.
 *
 * Source canônico: docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md §Forma canônica
 *                  + packages/db/migrations/0031_funnel_template_paid_workshop_v2.sql.
 */
const PAID_WORKSHOP_V2_BLUEPRINT = {
  version: 1,
  stages: [
    {
      slug: 'lead_workshop',
      source_events: ['Lead'],
      is_recurring: false,
    },
    {
      slug: 'clicked_buy_workshop',
      source_events: ['custom:click_buy_workshop'],
      is_recurring: true,
    },
    {
      slug: 'survey_responded',
      source_events: ['custom:survey_responded'],
      is_recurring: false,
    },
    {
      slug: 'watched_workshop',
      source_events: ['custom:watched_workshop'],
      is_recurring: false,
    },
    {
      slug: 'clicked_buy_main',
      source_events: ['custom:click_buy_main'],
      is_recurring: true,
    },
  ],
};

/**
 * Constrói um raw_events row "pending" com lead_id já resolvido + launch_id
 * (passa direto pelo processor sem chamar resolveLeadByAliases).
 */
function makeRawEventRow(eventName: string, eventIdSuffix: string) {
  return {
    id: RAW_EVENT_ID,
    workspaceId: WORKSPACE_ID,
    pageId: PAGE_ID,
    processingStatus: 'pending' as const,
    receivedAt: new Date('2026-05-04T12:00:01.000Z'),
    processedAt: null,
    processingError: null,
    headersSanitized: {},
    payload: {
      event_id: `evt-${eventIdSuffix}`,
      event_name: eventName,
      event_time: EVENT_TIME,
      lead_id: LEAD_ID, // pré-resolvido pelo Edge → skip resolveLeadByAliases
      launch_id: LAUNCH_ID, // necessário para getBlueprintForLaunch
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

/**
 * Constrói o Db mock completo:
 *   - select #1 → rawEvents row
 *   - select #2 → launches.funnel_blueprint (v2)
 *   - insert #1 → events (returning [{ id }])
 *   - insert #2..N → lead_stages (resolves [])
 *   - update      → markRawEventProcessed/Failed
 */
function makeDb(rawRow: ReturnType<typeof makeRawEventRow>, blueprint: unknown) {
  const eventsReturning = vi.fn().mockResolvedValue([{ id: 'evt-inserted' }]);
  const eventsValues = vi.fn().mockReturnValue({ returning: eventsReturning });
  const leadStagesValues = vi.fn().mockResolvedValue([]);

  let insertIdx = 0;
  const insert = vi.fn(() => {
    insertIdx++;
    if (insertIdx === 1) {
      return { values: eventsValues };
    }
    return { values: leadStagesValues };
  });

  const updateSetWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  let selectIdx = 0;
  const select = vi.fn(() => {
    selectIdx++;
    if (selectIdx === 1) {
      // rawEvents lookup
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([rawRow]),
          }),
        }),
      };
    }
    // launches.funnel_blueprint lookup
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ funnelBlueprint: blueprint }]),
        }),
      }),
    };
  });

  const db = { select, insert, update } as unknown as Parameters<
    typeof processRawEvent
  >[1];

  return { db, eventsValues, leadStagesValues };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processRawEvent — paid_workshop_v2 custom event matching (T-FUNIL-033)', () => {
  beforeEach(() => {
    // Cache do blueprint é module-level — limpar para forçar fetch determinístico
    blueprintCache.clear();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. custom:click_buy_workshop → clicked_buy_workshop (is_recurring=true)
  // -------------------------------------------------------------------------
  it('custom:click_buy_workshop em raw_events cria lead_stage clicked_buy_workshop com is_recurring=true', async () => {
    const rawRow = makeRawEventRow('custom:click_buy_workshop', 'click-buy-ws-001');
    const { db, leadStagesValues } = makeDb(rawRow, PAID_WORKSHOP_V2_BLUEPRINT);

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    // BR-EVENT-001: matching exato com prefixo `custom:` (sem normalização)
    expect(leadStagesValues).toHaveBeenCalledTimes(1);
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'clicked_buy_workshop',
        isRecurring: true,
        leadId: LEAD_ID,
        launchId: LAUNCH_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 2. custom:survey_responded → survey_responded (is_recurring=false)
  // -------------------------------------------------------------------------
  it('custom:survey_responded em raw_events cria lead_stage survey_responded (não-recorrente)', async () => {
    const rawRow = makeRawEventRow('custom:survey_responded', 'survey-001');
    const { db, leadStagesValues } = makeDb(rawRow, PAID_WORKSHOP_V2_BLUEPRINT);

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    expect(leadStagesValues).toHaveBeenCalledTimes(1);
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'survey_responded',
        isRecurring: false,
        leadId: LEAD_ID,
        launchId: LAUNCH_ID,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 3. custom:watched_workshop → watched_workshop (is_recurring=false)
  // -------------------------------------------------------------------------
  it('custom:watched_workshop em raw_events cria lead_stage watched_workshop (não-recorrente)', async () => {
    const rawRow = makeRawEventRow('custom:watched_workshop', 'watched-001');
    const { db, leadStagesValues } = makeDb(rawRow, PAID_WORKSHOP_V2_BLUEPRINT);

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    expect(leadStagesValues).toHaveBeenCalledTimes(1);
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'watched_workshop',
        isRecurring: false,
        leadId: LEAD_ID,
        launchId: LAUNCH_ID,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 4. custom:click_buy_main → clicked_buy_main (is_recurring=true)
  // -------------------------------------------------------------------------
  it('custom:click_buy_main em raw_events cria lead_stage clicked_buy_main com is_recurring=true', async () => {
    const rawRow = makeRawEventRow('custom:click_buy_main', 'click-buy-main-001');
    const { db, leadStagesValues } = makeDb(rawRow, PAID_WORKSHOP_V2_BLUEPRINT);

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    expect(leadStagesValues).toHaveBeenCalledTimes(1);
    expect(leadStagesValues).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'clicked_buy_main',
        isRecurring: true,
        leadId: LEAD_ID,
        launchId: LAUNCH_ID,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 5. Custom event não mapeado → NÃO cria stage
  // -------------------------------------------------------------------------
  it('custom event não mapeado (custom:foo_bar) NÃO cria nenhum lead_stage', async () => {
    const rawRow = makeRawEventRow('custom:foo_bar', 'unmapped-001');
    const { db, leadStagesValues } = makeDb(rawRow, PAID_WORKSHOP_V2_BLUEPRINT);

    const result = await processRawEvent(RAW_EVENT_ID, db);

    // Processor aceita o evento (insere em events), mas nenhum stage match.
    expect(result.ok).toBe(true);
    // BR-EVENT-001: matching é exato; sem fuzzy/prefix-strip — `custom:foo_bar`
    // não está em nenhum source_events do blueprint v2 → zero inserts.
    expect(leadStagesValues).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. Bonus: matching é case-sensitive e exige prefixo `custom:`
  //
  // Garantia adicional contra regressão — se alguém quebrar a regra de matching
  // exato (ex.: lower-casing ou remoção de prefixo), `click_buy_workshop` (sem
  // prefixo) começaria a virar `clicked_buy_workshop`, o que é incorreto.
  // -------------------------------------------------------------------------
  it('event_name sem prefixo `custom:` (ex.: click_buy_workshop) NÃO cria stage do blueprint v2', async () => {
    const rawRow = makeRawEventRow('click_buy_workshop', 'no-prefix-001');
    const { db, leadStagesValues } = makeDb(rawRow, PAID_WORKSHOP_V2_BLUEPRINT);

    const result = await processRawEvent(RAW_EVENT_ID, db);

    expect(result.ok).toBe(true);
    // Source_events do stage `clicked_buy_workshop` é EXATAMENTE
    // ['custom:click_buy_workshop']. Sem prefixo, não há match.
    expect(leadStagesValues).not.toHaveBeenCalled();
  });
});
