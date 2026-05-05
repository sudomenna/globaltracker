/**
 * Integration tests — Funil Paid Workshop v2 — audiences semantics
 *
 * T-ID: T-FUNIL-034 (Sprint 12) + T-FUNIL-040 (DSL alignment)
 *
 * Verifica que as audiences scaffoldadas pelo template v2
 * (`lancamento_pago_workshop_com_main_offer` post-migration 0031) segmentam
 * corretamente leads conforme stages do funil v2 (8 stages com `watched_workshop`
 * único, sem `watched_class_1/2/3`; com novos `survey_responded`, `clicked_buy_*`).
 *
 * Cenários cobertos (ver docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md
 * §Forma canônica/Audiences):
 *   1. Lead com `watched_workshop` aparece em `engajados_workshop` (`stage_gte`).
 *   2. Lead com `survey_responded` (e sem `purchased_main`) aparece em
 *      `respondeu_pesquisa_sem_comprar_main` (`stage_eq` + `stage_not`); ao
 *      adicionar `purchased_main`, sai dessa audience na próxima evaluation.
 *   3. Lead com `watched_workshop` AND NOT `purchased_main` aparece em
 *      `nao_compradores_workshop_engajados` (`stage_gte` + `stage_not`).
 *   4. Audience legacy `compradores_apenas_workshop` está com status='archived'
 *      após migration — `listActiveAudiences` não a retorna.
 *   5. T-FUNIL-040: aliases legacy (`stage` / `not_stage`) ainda são aceitos
 *      pelo evaluator e produzem o mesmo membership que os canônicos.
 *
 * BRs aplicáveis:
 *   - BR-AUDIENCE-003: query_definition validado por Zod no service layer.
 *   - INV-AUDIENCE-007: query_definition validado por AudienceQueryDefinitionSchema
 *     antes do uso no evaluator.
 *   - INV-AUDIENCE-003: snapshotHash determinístico — não muda quando o membership
 *     não muda.
 *
 * Ambiguidade DSL resolvida em T-FUNIL-040:
 *   O evaluator (`apps/edge/src/lib/audience.ts`) agora aceita o vocabulário
 *   canônico (`stage_eq` / `stage_not` / `stage_gte`) gravado pela migration
 *   0031. Para `stage_gte`, o evaluator carrega `funnel_blueprint.stages[]`
 *   do launch (via `query_definition.launch_id`) e expande para a lista de
 *   stages que aparecem a partir daquela posição na ordem canônica do funil.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @globaltracker/db — segue padrão de tests/integration/audience/*.test.ts
// ---------------------------------------------------------------------------

vi.mock('@globaltracker/db', () => ({
  audiences: {
    id: 'id',
    workspaceId: 'workspace_id',
    publicId: 'public_id',
    status: 'status',
    queryDefinition: 'query_definition',
    consentPolicy: 'consent_policy',
  },
  audienceSnapshots: {},
  audienceSnapshotMembers: {},
  leadStages: { leadId: 'lead_id', stage: 'stage' },
  leadIcpScores: { leadId: 'lead_id', isIcp: 'is_icp' },
  leads: { id: 'id', workspaceId: 'workspace_id', status: 'status' },
  leadConsents: {},
  audienceSyncJobs: {},
  // launches table — used by loadFunnelStageOrder (T-FUNIL-040). The mock returns
  // an object with an `id` key so Drizzle's eq() expressions construct without
  // throwing; the actual select is intercepted in makeDb's resolver below.
  launches: { id: 'id' },
}));

import {
  evaluateAudience,
  listActiveAudiences,
} from '../../../../apps/edge/src/lib/audience';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = '74860330-a528-4951-bf49-90f0b5c72521'; // = wkshop-cs-jun26 workspace
const LAUNCH_PUBLIC_ID = 'wkshop-cs-jun26';
const LAUNCH_ID = '11111111-1111-1111-1111-111111111111';

const AUD_ENGAJADOS_WORKSHOP = 'audience-engajados-workshop';
const AUD_RESP_PESQUISA = 'audience-respondeu-pesquisa-sem-main';
const AUD_NAO_COMPRADORES = 'audience-nao-compradores-workshop-engajados';
const AUD_COMPRADORES_MAIN = 'audience-compradores-main';
const AUD_LEGACY_ALIAS = 'audience-legacy-stage-alias';
const AUD_COMPRADORES_APENAS_WORKSHOP_LEGACY =
  'audience-compradores-apenas-workshop-legacy';

const LEAD_WATCHED_ONLY = 'lead-watched-workshop-001';
const LEAD_SURVEY_NO_MAIN = 'lead-survey-no-main-001';
const LEAD_SURVEY_BOUGHT_MAIN = 'lead-survey-bought-main-001';
const LEAD_ENGAJADO_NAO_COMPRADOR = 'lead-engajado-nao-comprador-001';
const LEAD_ENGAJADO_COMPRADOR_MAIN = 'lead-engajado-comprador-main-001';

// ---------------------------------------------------------------------------
// Funnel blueprint — canonical stage order for wkshop-cs-jun26 (paid workshop v2).
// Ordering matches the §Forma canônica/Stages of the v2 template.
// `stage_gte: "watched_workshop"` expands to {watched_workshop, clicked_buy_main,
// purchased_main} — every stage from watched_workshop forward.
// ---------------------------------------------------------------------------

const FUNNEL_STAGES_ORDER = [
  'lead_workshop',
  'purchased_workshop',
  'survey_responded',
  'wpp_joined',
  'watched_workshop',
  'clicked_buy_main',
  'purchased_main',
];

// ---------------------------------------------------------------------------
// World model — leads + suas stages (estado canônico do banco no test)
// ---------------------------------------------------------------------------

type AudienceRecord = {
  id: string;
  workspaceId: string;
  publicId: string;
  status: string;
  queryDefinition: unknown;
  consentPolicy: Record<string, unknown>;
};

type World = {
  /** Map lead_id → set of stage slugs registered for that lead. */
  leadStagesByLead: Map<string, Set<string>>;
  /** Active leads in workspace (status='active'). */
  activeLeadIds: Set<string>;
  /** Audiences keyed by id. */
  audiencesById: Map<string, AudienceRecord>;
  /** Funnel blueprint stages by launch_id. */
  blueprintByLaunch: Map<string, { stages: Array<{ slug: string }> }>;
};

function buildWorld(): World {
  const leadStagesByLead = new Map<string, Set<string>>([
    [LEAD_WATCHED_ONLY, new Set(['watched_workshop'])],
    [
      LEAD_SURVEY_NO_MAIN,
      new Set(['lead_workshop', 'purchased_workshop', 'survey_responded']),
    ],
    [
      LEAD_SURVEY_BOUGHT_MAIN,
      new Set([
        'lead_workshop',
        'purchased_workshop',
        'survey_responded',
        'purchased_main',
      ]),
    ],
    [
      LEAD_ENGAJADO_NAO_COMPRADOR,
      new Set([
        'lead_workshop',
        'purchased_workshop',
        'survey_responded',
        'wpp_joined',
        'watched_workshop',
      ]),
    ],
    [
      LEAD_ENGAJADO_COMPRADOR_MAIN,
      new Set([
        'lead_workshop',
        'purchased_workshop',
        'survey_responded',
        'wpp_joined',
        'watched_workshop',
        'clicked_buy_main',
        'purchased_main',
      ]),
    ],
  ]);

  const activeLeadIds = new Set(leadStagesByLead.keys());

  const audiencesById = new Map<string, AudienceRecord>([
    // engajados_workshop — canonical: {stage_gte: "watched_workshop"}
    [
      AUD_ENGAJADOS_WORKSHOP,
      {
        id: AUD_ENGAJADOS_WORKSHOP,
        workspaceId: WORKSPACE_ID,
        publicId: 'engajados_workshop',
        status: 'active',
        queryDefinition: {
          type: 'builder',
          launch_public_id: LAUNCH_PUBLIC_ID,
          launch_id: LAUNCH_ID,
          all: [{ stage_gte: 'watched_workshop' }],
        },
        consentPolicy: {},
      },
    ],
    // respondeu_pesquisa_sem_comprar_main — {stage_eq: survey_responded, stage_not: purchased_main}
    [
      AUD_RESP_PESQUISA,
      {
        id: AUD_RESP_PESQUISA,
        workspaceId: WORKSPACE_ID,
        publicId: 'respondeu_pesquisa_sem_comprar_main',
        status: 'active',
        queryDefinition: {
          type: 'builder',
          launch_public_id: LAUNCH_PUBLIC_ID,
          launch_id: LAUNCH_ID,
          all: [
            { stage_eq: 'survey_responded' },
            { stage_not: 'purchased_main' },
          ],
        },
        consentPolicy: {},
      },
    ],
    // nao_compradores_workshop_engajados — {stage_gte: watched_workshop, stage_not: purchased_main}
    [
      AUD_NAO_COMPRADORES,
      {
        id: AUD_NAO_COMPRADORES,
        workspaceId: WORKSPACE_ID,
        publicId: 'nao_compradores_workshop_engajados',
        status: 'active',
        queryDefinition: {
          type: 'builder',
          launch_public_id: LAUNCH_PUBLIC_ID,
          launch_id: LAUNCH_ID,
          all: [
            { stage_gte: 'watched_workshop' },
            { stage_not: 'purchased_main' },
          ],
        },
        consentPolicy: {},
      },
    ],
    // compradores_main — {stage_eq: purchased_main}
    [
      AUD_COMPRADORES_MAIN,
      {
        id: AUD_COMPRADORES_MAIN,
        workspaceId: WORKSPACE_ID,
        publicId: 'compradores_main',
        status: 'active',
        queryDefinition: {
          type: 'builder',
          launch_public_id: LAUNCH_PUBLIC_ID,
          launch_id: LAUNCH_ID,
          all: [{ stage_eq: 'purchased_main' }],
        },
        consentPolicy: {},
      },
    ],
    // T-FUNIL-040 retro-compat: legacy aliases (stage / not_stage) still accepted.
    [
      AUD_LEGACY_ALIAS,
      {
        id: AUD_LEGACY_ALIAS,
        workspaceId: WORKSPACE_ID,
        publicId: 'engajados_workshop_legacy_alias',
        status: 'active',
        queryDefinition: {
          type: 'builder',
          launch_public_id: LAUNCH_PUBLIC_ID,
          // No launch_id needed — only legacy fields used.
          all: [
            { stage: 'watched_workshop' },
            { not_stage: 'purchased_main' },
          ],
        },
        consentPolicy: {},
      },
    ],
    // compradores_apenas_workshop — legacy, removed by migration 0031 (status='archived').
    [
      AUD_COMPRADORES_APENAS_WORKSHOP_LEGACY,
      {
        id: AUD_COMPRADORES_APENAS_WORKSHOP_LEGACY,
        workspaceId: WORKSPACE_ID,
        publicId: 'compradores_apenas_workshop',
        status: 'archived',
        queryDefinition: {
          type: 'builder',
          all: [{ stage_eq: 'purchased_workshop' }],
        },
        consentPolicy: {},
      },
    ],
  ]);

  const blueprintByLaunch = new Map<
    string,
    { stages: Array<{ slug: string }> }
  >([
    [
      LAUNCH_ID,
      { stages: FUNNEL_STAGES_ORDER.map((slug) => ({ slug })) },
    ],
  ]);

  return { leadStagesByLead, activeLeadIds, audiencesById, blueprintByLaunch };
}

// ---------------------------------------------------------------------------
// Mock DB factory — stateful, simula evaluateAudience pipeline:
//   1. SELECT audience por id → retorna record do world.
//   2. SELECT funnel_blueprint FROM launches → retorna blueprint do world (se
//      a audience usa stage_gte).
//   3. SELECT leads com WHERE dinâmico → world resolve membership.
// ---------------------------------------------------------------------------

function makeDb(world: World) {
  let currentAudienceUnderEvaluation: AudienceRecord | null = null;

  function setAudienceUnderEvaluation(audienceId: string) {
    currentAudienceUnderEvaluation =
      world.audiencesById.get(audienceId) ?? null;
  }

  /**
   * Resolve membership for a query_definition. Honors all canonical and legacy
   * fields exactly as the evaluator does. `stage_gte` requires
   * `query_definition.launch_id` and the world's blueprint to expand the set
   * of qualifying stages.
   */
  function resolveLeads(
    queryDef: {
      launch_id?: string;
      all: Array<{
        stage?: string;
        not_stage?: string;
        stage_eq?: string;
        stage_not?: string;
        stage_gte?: string;
      }>;
    } | null,
  ): Array<{ id: string }> {
    if (!queryDef) return [];

    const blueprint = queryDef.launch_id
      ? world.blueprintByLaunch.get(queryDef.launch_id)
      : undefined;
    const stageOrder = blueprint?.stages.map((s) => s.slug) ?? [];

    return [...world.activeLeadIds]
      .filter((leadId) => {
        const stages = world.leadStagesByLead.get(leadId) ?? new Set<string>();
        for (const cond of queryDef.all) {
          const stageEq = cond.stage_eq ?? cond.stage;
          if (stageEq !== undefined && !stages.has(stageEq)) return false;
          const stageNot = cond.stage_not ?? cond.not_stage;
          if (stageNot !== undefined && stages.has(stageNot)) return false;
          if (cond.stage_gte !== undefined) {
            const idx = stageOrder.indexOf(cond.stage_gte);
            if (idx === -1) return false;
            const matching = stageOrder.slice(idx);
            if (!matching.some((s) => stages.has(s))) return false;
          }
        }
        return true;
      })
      .map((id) => ({ id }));
  }

  // Pipeline order inside evaluateAudience:
  //   1. db.select().from(audiences).where(...)
  //   2. (only if stage_gte present) db.select({funnelBlueprint: sql`funnel_blueprint`}).from(launches).where(...).limit(1)
  //   3. db.select({id: leads.id}).from(leads).where(...)
  //
  // We dispatch by inspecting the field shape passed to db.select():
  //   - bare select() → step 1 or 3 (audiences vs leads); we use a counter.
  //   - select({funnelBlueprint: ...}) → step 2 (blueprint).
  let stepCounter = 0;

  const db = {
    select: vi.fn().mockImplementation((projection?: unknown) => {
      const isBlueprintSelect =
        projection !== undefined &&
        projection !== null &&
        typeof projection === 'object' &&
        'funnelBlueprint' in projection;

      return {
        from: vi.fn().mockImplementation(() => {
          // Build chainable query — supports .where() and optional .limit().
          const finalize = () => {
            if (isBlueprintSelect) {
              const audience = currentAudienceUnderEvaluation;
              const queryDef = audience?.queryDefinition as
                | { launch_id?: string }
                | null;
              const launchId = queryDef?.launch_id;
              if (!launchId) return Promise.resolve([]);
              const bp = world.blueprintByLaunch.get(launchId);
              return Promise.resolve(
                bp ? [{ funnelBlueprint: bp }] : [],
              );
            }

            // Bare select — alternate audiences (step 0) → leads (step 1).
            // After the leads query, reset for next evaluateAudience invocation.
            if (stepCounter === 0) {
              stepCounter = 1;
              const audience = currentAudienceUnderEvaluation;
              return Promise.resolve(audience ? [audience] : []);
            }
            // Leads query
            const audience = currentAudienceUnderEvaluation;
            const queryDef = audience?.queryDefinition as
              | Parameters<typeof resolveLeads>[0]
              | null;
            const rows = resolveLeads(queryDef ?? null);
            stepCounter = 0;
            return Promise.resolve(rows);
          };

          const where = vi.fn().mockImplementation(() => {
            const result = {
              limit: vi.fn().mockImplementation(() => finalize()),
              then: (
                onFulfilled: (value: unknown) => unknown,
                onRejected?: (reason: unknown) => unknown,
              ) => finalize().then(onFulfilled, onRejected),
            };
            return result;
          });

          return { where };
        }),
      };
    }),
  };

  function makeListActiveDb() {
    return {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            const active = [...world.audiencesById.values()].filter(
              (a) => a.workspaceId === WORKSPACE_ID && a.status === 'active',
            );
            return Promise.resolve(active);
          }),
        })),
      })),
    };
  }

  return { db, setAudienceUnderEvaluation, makeListActiveDb };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('T-FUNIL-034 + T-FUNIL-040 — Funil paid workshop v2: audiences semantics', () => {
  let world: World;
  let mock: ReturnType<typeof makeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    world = buildWorld();
    mock = makeDb(world);
  });

  it('engajados_workshop (stage_gte: watched_workshop) inclui leads com watched_workshop e além', async () => {
    mock.setAudienceUnderEvaluation(AUD_ENGAJADOS_WORKSHOP);

    const result = await evaluateAudience(AUD_ENGAJADOS_WORKSHOP, {
      db: mock.db as never,
      workspaceId: WORKSPACE_ID,
    });

    // T-FUNIL-040: stage_gte expande para {watched_workshop, clicked_buy_main, purchased_main}
    // (toda stage que aparece a partir de watched_workshop na ordem do blueprint).
    //   LEAD_WATCHED_ONLY            tem watched_workshop                      → entra
    //   LEAD_ENGAJADO_NAO_COMPRADOR  tem watched_workshop                      → entra
    //   LEAD_ENGAJADO_COMPRADOR_MAIN tem watched_workshop + purchased_main     → entra
    //   LEAD_SURVEY_BOUGHT_MAIN      tem purchased_main (sem watched_workshop) → entra (saltou stages — está adiante de watched_workshop)
    expect(result.members).toContain(LEAD_WATCHED_ONLY);
    expect(result.members).toContain(LEAD_ENGAJADO_NAO_COMPRADOR);
    expect(result.members).toContain(LEAD_ENGAJADO_COMPRADOR_MAIN);
    expect(result.members).toContain(LEAD_SURVEY_BOUGHT_MAIN);

    // Leads que pararam antes de watched_workshop ficam fora
    expect(result.members).not.toContain(LEAD_SURVEY_NO_MAIN);

    expect(result.memberCount).toBe(4);
  });

  it('respondeu_pesquisa_sem_comprar_main (stage_eq + stage_not) reage à mutação purchased_main', async () => {
    mock.setAudienceUnderEvaluation(AUD_RESP_PESQUISA);
    const before = await evaluateAudience(AUD_RESP_PESQUISA, {
      db: mock.db as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(before.members).toContain(LEAD_SURVEY_NO_MAIN);
    expect(before.members).toContain(LEAD_ENGAJADO_NAO_COMPRADOR);
    expect(before.members).not.toContain(LEAD_SURVEY_BOUGHT_MAIN);
    expect(before.members).not.toContain(LEAD_ENGAJADO_COMPRADOR_MAIN);

    // Mutação: LEAD_SURVEY_NO_MAIN agora também comprou main.
    world.leadStagesByLead.get(LEAD_SURVEY_NO_MAIN)?.add('purchased_main');

    mock.setAudienceUnderEvaluation(AUD_RESP_PESQUISA);
    const after = await evaluateAudience(AUD_RESP_PESQUISA, {
      db: mock.db as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(after.members).not.toContain(LEAD_SURVEY_NO_MAIN);
    expect(after.members).toContain(LEAD_ENGAJADO_NAO_COMPRADOR);
    expect(after.memberCount).toBe(before.memberCount - 1);

    // INV-AUDIENCE-003: hash muda quando member set muda.
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });

  it('nao_compradores_workshop_engajados (stage_gte + stage_not) — purchased_main exclui mesmo quem assistiu o workshop', async () => {
    mock.setAudienceUnderEvaluation(AUD_NAO_COMPRADORES);

    const result = await evaluateAudience(AUD_NAO_COMPRADORES, {
      db: mock.db as never,
      workspaceId: WORKSPACE_ID,
    });

    // Inclui:
    //   LEAD_WATCHED_ONLY            (watched_workshop, sem purchased_main)
    //   LEAD_ENGAJADO_NAO_COMPRADOR  (watched_workshop, sem purchased_main)
    expect(result.members).toContain(LEAD_WATCHED_ONLY);
    expect(result.members).toContain(LEAD_ENGAJADO_NAO_COMPRADOR);

    // Exclui:
    //   LEAD_ENGAJADO_COMPRADOR_MAIN (tem purchased_main → stage_not exclui)
    expect(result.members).not.toContain(LEAD_ENGAJADO_COMPRADOR_MAIN);

    // Quem nem chegou em watched_workshop fica fora
    expect(result.members).not.toContain(LEAD_SURVEY_NO_MAIN);
    expect(result.members).not.toContain(LEAD_SURVEY_BOUGHT_MAIN);
  });

  it('compradores_main (stage_eq: purchased_main) inclui apenas quem comprou a oferta principal', async () => {
    mock.setAudienceUnderEvaluation(AUD_COMPRADORES_MAIN);

    const result = await evaluateAudience(AUD_COMPRADORES_MAIN, {
      db: mock.db as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.members).toContain(LEAD_SURVEY_BOUGHT_MAIN);
    expect(result.members).toContain(LEAD_ENGAJADO_COMPRADOR_MAIN);
    expect(result.members).not.toContain(LEAD_WATCHED_ONLY);
    expect(result.members).not.toContain(LEAD_SURVEY_NO_MAIN);
    expect(result.members).not.toContain(LEAD_ENGAJADO_NAO_COMPRADOR);
    expect(result.memberCount).toBe(2);
  });

  it('T-FUNIL-040 retro-compat: aliases legacy (stage / not_stage) continuam aceitos', async () => {
    // Mesma semântica da audience nao_compradores_workshop_engajados, porém
    // expressa com stage/not_stage (vocabulário pré-T-FUNIL-040). Membership
    // deve ser equivalente ao set "leads com watched_workshop sem purchased_main".
    mock.setAudienceUnderEvaluation(AUD_LEGACY_ALIAS);

    const result = await evaluateAudience(AUD_LEGACY_ALIAS, {
      db: mock.db as never,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.members).toContain(LEAD_WATCHED_ONLY);
    expect(result.members).toContain(LEAD_ENGAJADO_NAO_COMPRADOR);
    expect(result.members).not.toContain(LEAD_ENGAJADO_COMPRADOR_MAIN);
    expect(result.members).not.toContain(LEAD_SURVEY_NO_MAIN);
    expect(result.members).not.toContain(LEAD_SURVEY_BOUGHT_MAIN);
  });

  it('audience legacy compradores_apenas_workshop foi arquivada e não aparece em listActiveAudiences', async () => {
    const listDb = mock.makeListActiveDb();
    const active = await listActiveAudiences(WORKSPACE_ID, listDb as never);
    const publicIds = active.map((a: { publicId: string }) => a.publicId);

    expect(publicIds).not.toContain('compradores_apenas_workshop');

    expect(publicIds).toContain('engajados_workshop');
    expect(publicIds).toContain('respondeu_pesquisa_sem_comprar_main');
    expect(publicIds).toContain('nao_compradores_workshop_engajados');
    expect(publicIds).toContain('compradores_main');

    const legacy = world.audiencesById.get(
      AUD_COMPRADORES_APENAS_WORKSHOP_LEGACY,
    );
    expect(legacy?.status).toBe('archived');
  });
});
