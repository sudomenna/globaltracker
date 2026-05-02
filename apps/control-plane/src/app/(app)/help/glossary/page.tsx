import { GlossaryClient, type GlossaryTerm } from './glossary-client';

// Terms extracted from docs/00-product/06-glossary.md (T-6-022)
const GLOSSARY_TERMS: GlossaryTerm[] = [
  {
    term: 'AEM (Aggregated Event Measurement)',
    definition:
      'Mecanismo do Meta para iOS 14.5+ que limita medição de eventos. Exige priorização dos 8 eventos mais importantes por domínio em business.facebook.com → Events Manager → Aggregated Event Measurement.',
    notConfuse: '"iOS 14 limitation" — AEM é a solução; iOS 14 é o motivo.',
  },
  {
    term: 'API Secret (GA4)',
    definition:
      'Secret de autenticação do GA4 Measurement Protocol. Gerado em GA4 → Admin → Data Streams → API Secrets.',
    notConfuse: '"API key" — termo genérico; API Secret é específico do MP.',
  },
  {
    term: 'Attribution',
    definition:
      'Conjunto de campos (utm_*, click IDs, account_id/campaign_id/ad_id) que ligam um evento à origem de tráfego.',
    notConfuse:
      '"Source" / "Medium" GA4 — attribution é mais granular (8+ campos).',
  },
  {
    term: 'Audience',
    definition:
      'Definição declarativa de público (em audiences.query_definition). Materializada em audience_snapshots + audience_snapshot_members. Strategy condicional para Google.',
    notConfuse:
      '"Lista" — termo genérico; audience é entidade do GlobalTracker.',
  },
  {
    term: 'Audience Snapshot',
    definition:
      'Estado materializado de uma audience em um momento (snapshot_id, snapshot_hash, members). Permite cálculo de diff entre T-1 e T.',
    notConfuse: '"Audience" — audience é definição; snapshot é estado.',
  },
  {
    term: 'Audience Sync Job',
    definition:
      'Job que envia diff entre snapshot anterior e atual para Meta/Google. Lock por audience_id + platform_resource_id.',
    notConfuse:
      'Dispatch job — sync job opera em batch de leads, não em evento individual.',
  },
  {
    term: 'Audit Log',
    definition:
      'Tabela append-only audit_log registrando mutações em entidades de configuração + acessos a PII em claro. Retenção 7 anos.',
    notConfuse: '"Activity log" UI — audit log é técnico/legal.',
  },
  {
    term: 'Auto-tagging (Google Ads)',
    definition:
      'Recurso do Google Ads que adiciona gclid automaticamente nas URLs de destino dos anúncios. Sem ele, gclid precisa ser configurado manualmente. Ativável em ads.google.com → Configuração → Conta → Auto-tagging.',
    notConfuse:
      'Manual tagging — auto-tagging usa gclid; manual tagging usa UTMs custom.',
  },
  {
    term: 'CAPI (Conversions API)',
    definition:
      'API server-side do Meta para envio de eventos de conversão. Substitui ou complementa o Pixel browser. Permite enriquecimento de user_data server-side (ADR-006).',
    notConfuse: 'Pixel — Pixel é client-side; CAPI é server-side.',
  },
  {
    term: 'CAPI Token',
    definition:
      'Token de acesso (Bearer) emitido pelo Meta para autenticar chamadas à Conversions API. Vinculado a App + Pixel.',
    notConfuse: 'Page token — page token é nosso, CAPI token é do Meta.',
  },
  {
    term: 'Consent',
    definition:
      'Registro em lead_consents por finalidade (analytics, marketing, ad_user_data, ad_personalization, customer_match). Snapshot por evento em events.consent_snapshot.',
    notConfuse:
      '"Opt-in" — opt-in é mecanismo; consent é o registro auditável.',
  },
  {
    term: 'Conversion Action (Google Ads)',
    definition:
      'Definição em Google Ads de qual conversão rastrear (compra, lead, signup) com janela de atribuição e modelo. Tem ID próprio. Mapeado em launches.config.tracking.google.conversion_actions.',
    notConfuse:
      'Conversion event GA4 — Conversion Action é Google Ads, não GA4.',
  },
  {
    term: 'Cost ingestor',
    definition:
      'Cron diário que busca gasto Meta/Google e grava em ad_spend_daily com normalização cambial.',
    notConfuse:
      '"Billing" — cost é gasto em mídia, não billing do GlobalTracker.',
  },
  {
    term: 'Customer Match strategy',
    definition:
      'Atributo de audiences.destination_strategy para Google: google_data_manager / google_ads_api_allowlisted / disabled_not_eligible. ADR-012.',
    notConfuse:
      '"Audience type" Google — strategy é nossa decisão; type é da plataforma.',
  },
  {
    term: 'Data Manager API',
    definition:
      'API Google que substitui Google Ads API para Customer Match em novos adotantes a partir de abril/2026. ADR-012.',
    notConfuse: '"Google Ads API" — Data Manager é o novo path.',
  },
  {
    term: 'Design tokens',
    definition:
      'Variáveis nomeadas (cor, tipografia, espaço, radius, shadow, motion) que toda UI consome via CSS variables. Definição canônica em docs/70-ux/01-design-system-tokens.md.',
    notConfuse: 'Hex/px raw — proibidos em componentes; sempre token.',
  },
  {
    term: 'Dispatch',
    definition:
      'Envio de evento normalizado a destino externo (Meta CAPI, GA4 MP, Google Ads conversion, audience). Cada envio é um dispatch_job.',
    notConfuse:
      '"Webhook out" — dispatch tem semantics próprios (eligibility, retry, idempotency_key, DLQ).',
  },
  {
    term: 'Dispatch Attempt',
    definition:
      'Cada tentativa de envio é registrada em dispatch_attempts com payloads sanitizados, response status, erro.',
    notConfuse: 'Job — um job tem múltiplos attempts.',
  },
  {
    term: 'Dispatch Job',
    definition:
      'Linha em dispatch_jobs com status (pending → processing → succeeded/failed/skipped/dead_letter/retrying). Idempotency key derivada por destino (ADR-013).',
    notConfuse:
      '"Queue message" — message é transporte; job é a unidade rastreável.',
  },
  {
    term: 'Dispatcher',
    definition:
      'Worker async que consome dispatch_jobs e envia para destinos externos. Um dispatcher por destino (Meta CAPI, GA4, Google Ads, Audience).',
    notConfuse:
      'Webhook adapter — adapter é entrada (in); dispatcher é saída (out).',
  },
  {
    term: 'DLQ (Dead Letter Queue)',
    definition:
      'Destino final de mensagens/jobs que falharam após max_attempts. Permite reprocessamento manual.',
    notConfuse: '"Failed jobs" — DLQ é fila; failed jobs é status.',
  },
  {
    term: 'Doc-sync',
    definition:
      'Política de sincronização doc↔código no mesmo commit. Quando impossível, marcar [SYNC-PENDING] em MEMORY.md §2.',
    notConfuse: '"Code review" — doc-sync é fonte de verdade alinhada.',
  },
  {
    term: 'Domain Verification (Meta)',
    definition:
      'Processo no Meta Business Manager para comprovar posse de um domínio. Pré-requisito para AEM e para evitar penalização do Pixel. Configurado em business.facebook.com/settings/owned-domains.',
    notConfuse:
      'DNS — Domain Verification pode usar DNS, meta tag ou file upload.',
  },
  {
    term: 'Edge Gateway',
    definition:
      'Cloudflare Worker com Hono que recebe /v1/*. Faz validação síncrona + persistência em raw_events + 202. Não chama Meta/Google diretamente.',
    notConfuse: '"Backend" — termo genérico; edge gateway é específico.',
  },
  {
    term: 'Enhanced Conversions',
    definition:
      'Recurso Google Ads que enriquece conversão original com PII hashada via Google Ads API adjustment. Exige order_id + tag original com click ID.',
    notConfuse:
      '"Conversion upload" — enhanced conversions é evolução; upload é base.',
  },
  {
    term: 'Event',
    definition:
      'Tupla (workspace_id, event_id, event_name, event_time, ...) em events. Imutável. Vem de tracker (PageView/Lead/Purchase) ou webhook normalizado.',
    notConfuse:
      '"Hit" GA4 — semelhante mas GA4 tem campos próprios; event é interno.',
  },
  {
    term: 'Event Time Clamp',
    definition:
      'Regra do Edge que reescreve event_time para received_at quando offset > EVENT_TIME_CLAMP_WINDOW_SEC (default 300s). ADR-020.',
    notConfuse:
      '"Server time" — clamp é específico para casos de offset grande.',
  },
  {
    term: 'event_id interno',
    definition:
      "Identificador único de evento dentro do workspace. Para webhook, derivado de sha256(platform || ':' || platform_event_id)[:32] (ADR-019). Para tracker, gerado client-side (UUID-like).",
    notConfuse:
      'event_id Meta CAPI — Meta espera nosso event_id como eventID/event_id deles; mesma string usada para dedup.',
  },
  {
    term: 'fbc / fbp',
    definition:
      'Cookies Meta first-party para click ID (fbc) e browser ID (fbp). Capturados pelo tracker, propagados a CAPI.',
    notConfuse: 'fbclid — query param; fbc/fbp são cookies.',
  },
  {
    term: 'First-touch / Last-touch',
    definition:
      'Modelos de atribuição. First-touch: origem inicial do lead em (lead_id, launch_id). Last-touch: origem da conversão de lead. ADR-015.',
    notConfuse: '"Multi-touch" — Fase 3+.',
  },
  {
    term: 'FX (Foreign Exchange)',
    definition:
      'Taxa cambial usada para normalizar spend_cents → spend_cents_normalized na moeda do workspace. Provedor configurável (OQ-001).',
    notConfuse:
      '"Câmbio comercial" — FX aqui é técnico, não financeiro humano.',
  },
  {
    term: 'GA4 DebugView',
    definition:
      'Ferramenta do GA4 que mostra eventos em tempo real para debug. Ativada via debug_mode=1 no payload ou query param &debug_mode=1. Acessível em analytics.google.com → Admin → DebugView.',
    notConfuse:
      'Realtime — DebugView é apenas para debug; Realtime é dashboard de produção.',
  },
  {
    term: 'GA4 Measurement Protocol (MP)',
    definition:
      'API server-side do GA4 para envio de eventos. Equivalente conceitual ao CAPI do Meta. Usa client_id para deduplicação com gtag browser.',
    notConfuse: 'gtag.js — gtag é client-side; MP é server-side.',
  },
  {
    term: 'gclid / gbraid / wbraid',
    definition:
      'Click IDs Google em URL. gbraid para iOS app campaigns; wbraid para web app.',
    notConfuse: '"Google click" genérico — três tipos distintos.',
  },
  {
    term: '_gcl_au / _ga',
    definition:
      'Cookies Google first-party. _gcl_au é Google Ads conversion linker; _ga é GA4 client_id. Capturados, não criados.',
    notConfuse: 'gclid — cookie persiste; gclid é one-shot URL.',
  },
  {
    term: 'Health Badge',
    definition:
      'Componente visual que mostra estado verde/amarelo/vermelho/cinza de uma seção ou recurso. Agregado de métricas underlying.',
    notConfuse:
      'Status indicator genérico — Health Badge é o componente padronizado.',
  },
  {
    term: 'HKDF',
    definition:
      'Função de derivação de chave (workspace_key = HKDF(PII_MASTER_KEY_V{n}, salt=workspace_id, info="pii")).',
    notConfuse: '"PBKDF2" — outro algoritmo; HKDF é o usado aqui.',
  },
  {
    term: 'Idempotency Key',
    definition:
      'Chave que garante que envio repetido não causa duplicata. Derivada como sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource) (ADR-013).',
    notConfuse:
      'Event ID — event_id identifica o evento; idempotency key identifica o envio.',
  },
  {
    term: 'Ingestion Processor',
    definition:
      'Worker async (CF Queue consumer) que normaliza raw_events → events/leads/lead_stages e cria dispatch_jobs.',
    notConfuse: 'Edge Gateway — gateway é síncrono; processor é assíncrono.',
  },
  {
    term: 'Lançamento (Launch)',
    definition:
      'Janela de operação de marketing com tracking config próprio (Pixel ID, conversion actions, audiences). Tem public_id legível e UUID interno.',
    notConfuse:
      '"Campaign" (entidade Meta/Google que vive dentro de um Lançamento).',
  },
  {
    term: 'Lead',
    definition:
      'Indivíduo identificado por ao menos um identificador (email, phone, external_id) em um workspace. Tem PII hash + enc + lead_public_id.',
    notConfuse:
      '"Visitor" — visitor é anônimo (cobra __fvid); lead tem identidade.',
  },
  {
    term: 'Lead Alias',
    definition:
      'Ligação (workspace_id, identifier_type, identifier_hash) → lead_id em lead_aliases. Substitui unique constraints em leads.',
    notConfuse: 'Lead — um lead pode ter múltiplos aliases.',
  },
  {
    term: 'Lead Merge',
    definition:
      'Fusão de N leads em um canonical (mais antigo). Auditado em lead_merges. Atualiza FKs em events/lead_attribution/lead_stages.',
    notConfuse: '"Deduplicação" genérica — merge é canônico e auditado.',
  },
  {
    term: 'Lead Stage',
    definition:
      'Marcação em lead_stages indicando posição do lead no funil (registered, purchased, watched_class_3). Pode ser único ou recorrente.',
    notConfuse: 'Funnel completo — stage é um ponto; funnel é a sequência.',
  },
  {
    term: 'Lead Token (__ftk)',
    definition:
      'Cookie first-party assinado (HMAC-SHA256) emitido por /v1/lead. Permite reidentificação em retornos sem reenviar PII. TTL 30–90d. Binding ao page_token_hash.',
    notConfuse: 'lead_id em claro — __ftk é claim opaco.',
  },
  {
    term: 'lead_public_id',
    definition:
      'Identificador público do lead (UUID v4) usado em propagação cross-domain (LP→checkout). Não-PII, não-guessable.',
    notConfuse: 'lead_id interno (UUID em FKs).',
  },
  {
    term: 'Link curto / Redirector',
    definition:
      'Slug em links que redireciona via /r/:slug para destino com UTMs propagados. Registra clique em link_clicks.',
    notConfuse: 'Bitly/short.io — sistema próprio, integrado ao tracker.',
  },
  {
    term: 'Match Quality Score (Meta)',
    definition:
      'Score 0-10 retornado pelo Meta após dispatch indicando quão bem user_data permitiu match com usuário Facebook. Quanto mais campos enviados (em, ph, fbc, fbp, etc.), maior.',
    notConfuse:
      '"Conversion accuracy" genérico — Match Quality é métrica específica do Meta.',
  },
  {
    term: 'Measurement ID (GA4)',
    definition:
      'Identificador de Data Stream do GA4 no formato G-XXXXXXXX. Configurado em launches.config.tracking.google.ga4_measurement_id. Encontrável em GA4 → Admin → Data Streams.',
    notConfuse:
      'Property ID — Measurement ID identifica stream; Property ID identifica property.',
  },
  {
    term: 'Onda de paralelização',
    definition:
      'Grupo de 3–5 T-IDs parallel-safe=yes com ownership disjunto, executadas em paralelo por subagents.',
    notConfuse: '"Sprint" — sprint contém múltiplas ondas.',
  },
  {
    term: 'Onboarding wizard',
    definition:
      'Fluxo guiado de 5 passos para configuração mínima funcional do workspace. Skippable; estado em workspaces.onboarding_state.',
    notConfuse: 'Tutorial — wizard tem ações reais; tutorial é didático.',
  },
  {
    term: 'Página (Page)',
    definition:
      'LP/checkout/sales registrado no GlobalTracker, com event_config, allowed_domains e page_token. Modos: a_system, b_snippet, c_webhook.',
    notConfuse: 'URL bruta — pages.url é apenas referência informativa.',
  },
  {
    term: 'Page Token Rotation',
    definition:
      'Substituição de page_token com janela de overlap (default 14 dias) durante a qual ambos são aceitos. ADR-023.',
    notConfuse: '"Token refresh" OAuth — rotation é diferente.',
  },
  {
    term: 'PageToken',
    definition:
      'Identificador público escopado a uma página, embutido em snippet HTML. Hash em DB; rotação com janela de overlap (ADR-023).',
    notConfuse:
      '"API key" — page_token não dá acesso a operações administrativas.',
  },
  {
    term: 'Pixel ID',
    definition:
      'Identificador único de um Meta Pixel (15-16 dígitos). Configurado em launches.config.tracking.meta.pixel_id. Encontrável em business.facebook.com → Events Manager → Pixel.',
    notConfuse: 'Pixel browser script — ID é o número; pixel é o conjunto.',
  },
  {
    term: 'Pixel Policy',
    definition:
      'Atributo de pages.event_config definindo coordenação browser↔server: server_only / browser_and_server_managed / coexist_with_existing_pixel. ADR-011.',
    notConfuse:
      '"Server-side tracking" — pixel policy é decisão por página, não global.',
  },
  {
    term: 'PII Key Version (pii_key_version)',
    definition:
      'Versão da chave AES-GCM usada para criptografar PII em um registro. Permite rotação sem downtime via lazy re-encryption (ADR-009).',
    notConfuse:
      '"Encryption version" genérico — pii_key_version é específico do GlobalTracker.',
  },
  {
    term: 'Raw Event',
    definition:
      'Payload bruto recebido pelo Edge antes de normalização. Persistido em raw_events para o modelo "fast accept" (ADR-004). Retenção 7 dias.',
    notConfuse: 'Event — raw_event é pré-processamento; event é normalizado.',
  },
  {
    term: 'Replay protection',
    definition:
      'Mecanismo que rejeita request com event_id já visto nos últimos 7 dias (cache em CF KV). ADR-021.',
    notConfuse:
      '"Idempotency" — idempotency é correção de duplicata pós-aceito; replay protection rejeita pré-aceito.',
  },
  {
    term: 'SAR (Subject Access Request)',
    definition:
      'Pedido legal (LGPD/GDPR) de erasure ou acesso. No GlobalTracker, executado via DELETE /v1/admin/leads/:lead_id. ADR-014.',
    notConfuse: '"Data export" — export pode existir mas SAR aqui é erasure.',
  },
  {
    term: 'shadcn/ui',
    definition:
      'Biblioteca de componentes React baseada em Radix Primitives + Tailwind. Não é dependência runtime — código copiado para apps/control-plane/src/components/ui/ e customizado via tokens locais.',
    notConfuse: 'Material UI / Chakra — diferentes; shadcn é "owned code".',
  },
  {
    term: 'Skill (Claude Code)',
    definition:
      'Pacote em .claude/skills/<name>/SKILL.md com convenções/prompts reutilizáveis. Ex.: design-system que extrai tokens de URL.',
    notConfuse:
      'Subagent — skill é prompt; subagent é tipo de agent (.claude/agents/).',
  },
  {
    term: 'T-ID',
    definition:
      'Identificador de tarefa atômica de execução em sprint (T-<N>-<NUM>). Cabe em UM PR. Tem ownership concreto + DoD.',
    notConfuse: '"Issue GitHub" — T-ID é mais granular e estruturado.',
  },
  {
    term: 'Test Event Code',
    definition:
      'String configurável no Meta CAPI que marca evento como teste. Faz aparecer em Events Manager → Test Events sem afetar produção. Configurável em META_CAPI_TEST_EVENT_CODE ou por workspace.',
    notConfuse: 'Debug mode — Meta usa test event code; GA4 usa debug_mode.',
  },
  {
    term: 'Test Mode (workspace)',
    definition:
      'Estado temporário do workspace (TTL 1h) que faz tracker.js, Edge e dispatchers tratarem eventos como teste. Não afetam dashboards nem audiences. Toggle em /launches/:id/events/live.',
    notConfuse:
      'Sandbox env — test mode é por workspace em produção; sandbox é env separado.',
  },
  {
    term: 'Tracker.js',
    definition:
      'Script TS vanilla < 15 KB gzipped instalado em LPs. Lê config, captura attribution, envia eventos, gerencia cookies __fvid/__ftk.',
    notConfuse: '"Pixel" Meta — pixel é blob fechado; tracker.js é nosso.',
  },
  {
    term: 'Visitor (__fvid)',
    definition:
      'Cookie anônimo first-party com UUID v4 gerado pelo tracker. Existe na Fase 3 para multi-touch. Em Fases 1–2, coluna events.visitor_id fica reservada (nullable).',
    notConfuse: 'Lead — visitor é pré-identificação.',
  },
  {
    term: 'WCAG 2.2 AA',
    definition:
      'Standard de acessibilidade alvo do Control Plane. Inclui critérios novos do 2.2: target size 24×24px (2.5.8), focus appearance (2.4.11), dragging movements (2.5.7), consistent help (3.2.6).',
    notConfuse: 'WCAG 2.1 — versão anterior, menos critérios.',
  },
  {
    term: 'Webhook Adapter',
    definition:
      'Handler de webhook inbound (Hotmart, Stripe, Kiwify) em apps/edge/src/routes/webhooks/<provider>.ts. Valida signature + normaliza payload.',
    notConfuse: 'Dispatcher — adapter é in; dispatcher é out.',
  },
  {
    term: 'Workspace',
    definition:
      'Tenant lógico do GlobalTracker. Cada cliente/operador tem um. Todas as tabelas têm workspace_id. RLS no Postgres garante isolamento.',
    notConfuse:
      '"Cliente" (genérico), "Conta" (Meta/Google têm seu próprio conceito).',
  },
];

export default function GlossaryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Glossário</h1>
        <p className="text-sm text-muted-foreground">
          Termos e conceitos canônicos do GlobalTracker
        </p>
      </div>

      <GlossaryClient terms={GLOSSARY_TERMS} />
    </div>
  );
}
