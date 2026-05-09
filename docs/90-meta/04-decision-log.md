# 04 — Decision Log

Decisões arquiteturais aceitas. Apenas-anexar — decisões superadas viram `superseded by ADR-XXX`, não removidas.

---

## ADR-001 — Stack canônica

### Status
Aceito (2026-05-01).

### Contexto
GlobalTracker é um Runtime de tracking público que recebe milhões de eventos/dia em latência sub-segundo, dispara para Meta CAPI / Google Ads / GA4 com idempotência, e armazena dados sensíveis com requisitos LGPD/GDPR. Stack precisa suportar: edge low-latency, queues at-least-once, Postgres com jsonb e RLS, criptografia AES-GCM, secret management.

### Decisão
- **Edge Runtime:** Cloudflare Workers + Hono.
- **DB:** Postgres via Supabase (gerenciado) + Hyperdrive para conexão eficiente do Worker.
- **ORM:** Drizzle (typesafe, migrations versionadas, próximo de SQL).
- **Filas:** Cloudflare Queues (at-least-once, integrado ao Worker).
- **Cache/KV:** Cloudflare KV (config cache, rate limit, replay protection).
- **Crons:** Cloudflare Cron Triggers.
- **Workflows complexos (Fase 5):** Trigger.dev.
- **Validação:** Zod em todas as fronteiras.
- **Frontend Control Plane (Fase 4):** Next.js 15 (App Router) + shadcn.
- **LP Templates (Fase 5):** Astro.
- **Tracker:** TypeScript vanilla, sem deps, bundle < 15 KB gzipped.

### Alternativas consideradas
- AWS Lambda + API Gateway: maior latência regional, complexidade de deploy global.
- Vercel Edge Functions: menos maduro para queues at-least-once.
- DynamoDB / Mongo: jsonb e RLS do Postgres são essenciais para audit + multi-tenant.
- BullMQ / SQS: CF Queues integra nativamente com Workers — menor latência e ops.

### Consequências
- (+) Latência baixa global, custo previsível, integração nativa entre Worker/Queue/KV/Cron.
- (+) Workers + Hyperdrive permitem escrita Postgres com pool gerenciado.
- (−) Lock-in em Cloudflare. Mitigação: lógica de domínio fica em `lib/domain/` agnóstica; portabilidade requer reescrever só o entry-point.
- (−) Workers têm limites de CPU (50ms-30s). Mitigação: modelo "fast accept" (ADR-004).

### Impacta
Todos os módulos. ADR de origem para `10-architecture/02-stack.md`.

---

## ADR-002 — Multi-tenant via `workspace_id` em todas as tabelas

### Status
Aceito.

### Contexto
GlobalTracker é multi-tenant; cada cliente é um workspace isolado. Precisa garantir que dados de um workspace nunca vazem para outro, mesmo em joins acidentais ou queries malformadas.

### Decisão
- Toda tabela de domínio inclui `workspace_id uuid not null references workspaces(id)`.
- Toda query inclui `WHERE workspace_id = $w` como primeiro filtro.
- RLS (Row-Level Security) ativo no Postgres como segunda camada de defesa.
- Crypto key derivada por workspace via HKDF (ADR-009).

### Alternativas consideradas
- Schema-per-tenant: complexidade operacional (migrations N vezes, backup/restore por tenant).
- Database-per-tenant: custo proibitivo, impede joins analíticos cross-tenant em rollups internos.

### Consequências
- (+) Isolamento simples e auditável.
- (+) Permite rollups cross-tenant para analytics interno (com cuidado).
- (−) Risco de bug de filtro vazar dados. Mitigação: testes RBAC obrigatórios + RLS como cinto de segurança.

### Impacta
Todas as tabelas em `30-contracts/02-db-schema-conventions.md` e `20-domain/`.

---

## ADR-003 — IDs duplos: UUID interno + `public_id` externo

### Status
Aceito.

### Contexto
Snippets HTML em LPs externas, YAML de configuração e URLs de redirector precisam de IDs legíveis e estáveis. Mas IDs em código de produção precisam ser UUIDs não-enumeráveis para segurança e refactor-safety.

### Decisão
Toda entidade exposta publicamente tem dois IDs:
- `id uuid primary key` — usado em joins, FKs, queries internas.
- `public_id text` (slug ou random string) — usado em snippets, URLs, YAML.

Tabela em `planejamento.md` v3.0 Seção 8 lista todas: workspaces, launches, pages, links, audiences, page_tokens. `lead` tem `lead_public_id` para propagação cross-domain.

### Alternativas consideradas
- ID único composto (UUID + slug humano): perde unicidade e refactor.
- Apenas UUID: operadores reclamam que YAML fica ilegível.

### Consequências
- (+) UUIDs nunca aparecem em HTML público.
- (+) Refactor de schema não quebra snippets em produção.
- (−) Dois campos para manter sincronizados; tested via constraints `unique`.

### Impacta
`MOD-WORKSPACE`, `MOD-LAUNCH`, `MOD-PAGE`, `MOD-IDENTITY`, `MOD-ATTRIBUTION`, `MOD-AUDIENCE`.

---

## ADR-004 — Modelo "fast accept" no Edge

### Status
Aceito (decisão D4 da revisão arquitetural 2026-05-01).

### Contexto
RNF-001 exige `/v1/events` p95 < 50ms. Modelo original (Edge faz 4+ writes serializados a Postgres via Hyperdrive: events + leads + lead_stages + dispatch_jobs) facilmente estoura 150ms p95. CF Workers têm CPU limit; serializar muitos writes é arriscado.

### Decisão
Edge faz validação síncrona (token, CORS, schema, rate limit, replay, lead_token HMAC, event_time clamp) e insere em **uma única tabela** `raw_events` com payload em jsonb. Retorna `202 Accepted` em ms.

Um **Ingestion Processor** (CF Queue consumer) lê `raw_events`, normaliza para `events`/`leads`/`lead_stages` (com merge via `lead_aliases`) e cria `dispatch_jobs`.

### Alternativas consideradas
- Writes serializados no Edge: latência inaceitável.
- Edge → Queue direto sem `raw_events`: perde durabilidade se Queue falhar antes do enqueue.

### Consequências
- (+) Latência < 50ms no Edge.
- (+) `raw_events` é durabilidade explícita: evento aceito está em DB antes do 202.
- (−) Adiciona um hop (Edge → raw_events → processor → DB). Visibilidade de processamento é assíncrona.
- (−) Tabela `raw_events` cresce. Mitigação: retenção 7 dias após `processed_at`.

### Impacta
`MOD-EVENT`, `RNF-001`, `apps/edge/src/lib/raw-events-processor.ts`.

---

## ADR-005 — Identidade de lead via `lead_aliases` + `lead_merges`

### Status
Aceito (substitui modelo original que tinha 3 unique constraints em `leads`).

### Contexto
Versão original do schema tinha `unique (workspace_id, email_hash)`, `unique (workspace_id, phone_hash)`, `unique (workspace_id, external_id_hash)` em `leads`. Cenário real quebra: lead A cadastra com email-only, lead B (mesma pessoa, outro device) com phone-only, T+5 mesma pessoa preenche form com email+phone — insert falha por unique conflict, sistema fica preso.

### Decisão
- Remover unique constraints de `leads`.
- Tabela nova `lead_aliases (workspace_id, identifier_type, identifier_hash, lead_id, status)` com unique parcial `where status='active'`.
- Tabela `lead_merges (canonical_lead_id, merged_lead_id, reason, performed_by, before_summary, after_summary)` para auditoria.
- Algoritmo de resolução: 0 leads → criar; 1 lead → atualizar; N>1 leads → merge (canonical = mais antigo, atualiza FKs em events/lead_attribution/lead_stages/lead_consents/lead_survey_responses/lead_icp_scores; marca não-canônicos como `merged`; move aliases).

### Alternativas consideradas
- Manter unique constraints e exigir lead único na entrada: contraria realidade de tracking multi-device.
- Lead único composto (email+phone+external_id): muitas linhas com NULLs, NULL-distinct bug.

### Consequências
- (+) Suporta merge canônico auditável.
- (+) Suporta múltiplos identificadores por lead naturalmente.
- (−) Lookup de lead requer join via `lead_aliases` em vez de WHERE direto. Mitigação: índice `(workspace_id, identifier_type, identifier_hash) where status='active'`.
- (−) Merge requer transação coordenada — risco de inconsistência se interrompida. Mitigação: transaction + audit em `lead_merges`.

### Impacta
`MOD-IDENTITY`, `BR-IDENTITY-*`, `CONTRACT-event-lead-v1` (resolver agora retorna `LeadResolutionResult` com `merge_executed: boolean`).

---

## ADR-006 — Reidentificação de retornantes via cookie `__ftk` + `lead_token` HMAC

### Status
Aceito (decisão D3 — Fase 2).

### Contexto
Lead que se cadastrou em T0 retorna em T+5 dias e dispara InitiateCheckout. Para Meta CAPI / Google Ads enriquecerem `user_data` com email/phone hash + `fbc`/`fbp`, sistema precisa saber que é o mesmo lead — sem o browser reenviar PII.

### Decisão
- `/v1/lead` emite `lead_token` (HMAC-SHA256 com `LEAD_TOKEN_HMAC_SECRET`, claims: `workspace_id, lead_id, page_token_hash, exp`).
- Backend setta cookie first-party `__ftk` (SameSite=Lax, Secure, sem HttpOnly — tracker precisa ler) com TTL 30–90 dias.
- `tracker.js` lê `__ftk` e anexa `lead_token` aos eventos subsequentes.
- Edge valida HMAC, resolve `lead_id`, dispatcher Meta CAPI faz lookup em `leads` para enriquecer.
- Falha de validação → evento aceito como anônimo + métrica `lead_token_validation_failures`.

### Alternativas consideradas
- `lead_id` em claro no cookie: vulnerável a poluição de atribuição (qualquer um se identifica como lead alheio).
- JWT padrão: payload exposto no client; usar HMAC opaco é mais simples.
- Cookie HttpOnly + endpoint server-side em todo evento: latência inaceitável.

### Consequências
- (+) Reidentificação funciona sem expor PII no client.
- (+) Binding ao `page_token_hash` previne uso cross-page.
- (−) Cookie sem HttpOnly é lível por XSS na LP externa. Mitigação: TTL curto, revogação ativa via `lead_tokens.revoked_at`, monitoring.

### Impacta
`MOD-IDENTITY`, `MOD-EVENT`, `MOD-DISPATCH`, `apps/edge/src/lib/lead-token.ts`, `apps/edge/src/lib/cookies.ts`. Implementação em Sprint 2.

---

## ADR-007 — `visitor_id` adiado para Fase 3

### Status
Aceito (decisão D2 da revisão).

### Contexto
Análise inicial sugeria `visitor_id` (cookie anônimo `__fvid`) como bloqueador da Fase 1, para suportar atribuição cross-session multi-touch. Calibração posterior: para o caso de uso primário (PageView para remarketing Meta/Google + first-touch no momento do cadastro), `visitor_id` não é necessário — `fbc`/`fbp`/`_gcl_au` cobrem remarketing, e localStorage client-side cobre first-touch.

### Decisão
- Coluna `visitor_id text` em `events` fica reservada (nullable) na Fase 1.
- Tracker captura attribution params em localStorage e replaya no `/v1/lead`. Suficiente para first-touch no momento do cadastro.
- `__fvid` cookie e retroactive linking entre PageViews anônimos e Lead cadastrado entram na Fase 3 (multi-touch).

### Consequências
- (+) Reduz escopo da Fase 1 sem perda funcional para o caso de remarketing/first-touch básico.
- (−) Auditoria de jornada anônima individual fica indisponível até Fase 3.

### Impacta
`MOD-EVENT`, `MOD-ATTRIBUTION`, RF-???? (visitor_id), Sprint 1 vs Sprint 5.

---

## ADR-008 — Trigger.dev só na Fase 5

### Status
Aceito (decisão D5).

### Contexto
v2.0 mencionava Trigger.dev sem definir papel. Calibração: CF Cron + CF Queues cobrem todas necessidades de Fases 1–4 (ingestão, dispatch, cost ingestor, audience sync). Trigger.dev tem valor para workflows complexos com aprovação humana e UI de execução — exatamente o que o Orchestrator (provisioning de campanhas, deploy de LPs) precisa.

### Decisão
- Fases 1–4: CF Cron + CF Queues exclusivamente.
- Fase 5: Trigger.dev para Orchestrator (LP templates, setup tracking automatizado, provisionamento Meta/Google com aprovação humana).

### Consequências
- (+) Reduz superfície operacional do MVP.
- (+) Trigger.dev entra com valor real (UI de workflow + observabilidade) onde precisa.
- (−) Time precisa aprender Trigger.dev na Fase 5. Mitigação: ADR + documentação dedicada quando entrar.

### Impacta
`10-architecture/05-realtime-jobs.md`, Sprint 7.

---

## ADR-009 — PII: hash + AES-256-GCM com `pii_key_version` e HKDF por workspace

### Status
Aceito.

### Contexto
PII (email, phone, name) precisa ser pesquisável (matching, dedup) E exibível (suporte operacional autorizado) E rotacionável (compliance). Hash puro perde reversibilidade; encrypt puro perde matching; sem versionamento perde rotação sem downtime.

### Decisão
- Cada PII tem três representações: `*_hash` (SHA-256 após normalização) para matching; `*_enc` (AES-256-GCM com chave de workspace) para exibição autorizada; `*` em claro nunca persistido.
- Coluna `pii_key_version smallint` em `leads` indica qual versão da chave foi usada.
- `PII_MASTER_KEY_V{n}` versionado em secret manager. Re-encryption: lazy on read OU batch background opcional.
- Derivação por workspace: `workspace_key = HKDF(PII_MASTER_KEY_V{n}, salt=workspace_id, info="pii")`.

### Alternativas consideradas
- Field-level encryption gerenciado pelo provedor (Supabase Vault): vendor-specific, não atende rotação granular por workspace.
- Apenas hash sem encrypt: impede recovery para SAR e suporte.

### Consequências
- (+) Compromisso de uma chave de workspace não compromete outros.
- (+) Rotação de master key é gradual, sem downtime.
- (−) Lookup admin para mostrar email exige decrypt — operação auditada.

### Impacta
`MOD-IDENTITY`, `BR-PRIVACY-*`, `apps/edge/src/lib/pii.ts`.

---

## ADR-010 — Consent como entidade própria com 5 finalidades

### Status
Aceito.

### Contexto
LGPD/GDPR exigem consentimento por finalidade, com prova auditável. Booleano único `consent: true` é insuficiente — Meta exige `consent_ad_user_data`/`consent_ad_personalization`; Google exige `consent_customer_match`.

### Decisão
- Tabela `lead_consents` com 5 colunas separadas: `consent_analytics`, `consent_marketing`, `consent_ad_user_data`, `consent_ad_personalization`, `consent_customer_match`. Valores: `granted | denied | unknown`.
- Cada evento traz snapshot do consent em `events.consent_snapshot` (jsonb) — prova histórica.
- Dispatcher bloqueia destino quando consent exigido por aquele destino estiver `denied` ou `unknown` (em modo estrito).
- `policy_version` em `lead_consents` permite versionar mudanças de política.

### Consequências
- (+) Auditável; cada evento sabe sob qual policy_version foi capturado.
- (+) Bloqueio granular sem perder evento (vai como `skipped`).
- (−) Mais campos para a UI capturar. Mitigação: defaults sensatos por workspace.

### Impacta
`MOD-IDENTITY`, `MOD-DISPATCH`, `BR-CONSENT-*`.

---

## ADR-011 — Política de Pixel por página

### Status
Aceito.

### Contexto
LPs externas frequentemente já têm Meta Pixel próprio. Disparar CAPI sem coordenação cria duplicatas em Meta. Disparar só CAPI sem Pixel browser perde sinal de match. Solução universal não existe — depende do controle sobre a LP.

### Decisão
Cada `pages.event_config` declara um valor:
- `server_only`: Sem Pixel browser. Apenas CAPI.
- `browser_and_server_managed`: Tracker controla Pixel + CAPI com `event_id` compartilhado para dedup.
- `coexist_with_existing_pixel`: LP tem Pixel próprio; operador deve mapear forma de compartilhar `event_id`. Caso contrário, CAPI para eventos duplicáveis fica desabilitada e alertada.

### Consequências
- (+) Suporta os três cenários reais sem decisão centralizada.
- (−) Operador precisa entender a opção que escolheu. Mitigação: validação no Control Plane com avisos.

### Impacta
`MOD-PAGE`, `MOD-DISPATCH`, `MOD-TRACKER`, `BR-DISPATCH-*`.

---

## ADR-012 — Customer Match Google: estratégia condicional

### Status
Aceito.

### Contexto
Google anunciou em 2026-03 que novos adotantes via Google Ads API podem não ser aceitos para Customer Match a partir de 1º abril 2026; recomendação oficial passou a Data Manager API. Tokens não-allowlisted recebem `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`.

### Decisão
`audiences.destination_strategy` ∈ {`google_data_manager`, `google_ads_api_allowlisted`, `disabled_not_eligible`}.
- Default novo workspace: `google_data_manager`.
- Workspace com elegibilidade comprovada: `google_ads_api_allowlisted`.
- Sem consent / sem credenciais / não elegível: `disabled_not_eligible` com mensagem ao operador.

### Consequências
- (+) Sistema continua funcionando após mudança Google sem retrabalho.
- (−) Lógica de dispatch de audience tem branching. Mitigação: encapsular em `apps/edge/src/dispatchers/audience-sync.ts` com strategy pattern.

### Impacta
`MOD-AUDIENCE`, `40-integrations/05-google-customer-match.md`, `BR-AUDIENCE-*`.

---

## ADR-013 — Idempotency key canonicalizada por destino

### Status
Aceito.

### Contexto
Mesmo evento pode ser despachado para múltiplos destinos (Meta CAPI + GA4 + Google Conversion Upload) e cada um precisa de idempotência independente. Chave global por evento criaria conflito.

### Decisão
```
idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
```

Onde `destination_subresource` =
- `pixel_id` para Meta CAPI
- `conversion_action` para Google Ads conversion upload
- `measurement_id` para GA4 MP
- `audience_id` para Customer Match

### Consequências
- (+) Mesmo evento, múltiplos destinos, todos idempotentes independente.
- (+) Retry de um destino não afeta outro.

### Impacta
`MOD-DISPATCH`, todas as integrações em `40-integrations/`.

---

## ADR-014 — Retenção e SAR explícitos

### Status
Aceito.

### Contexto
LGPD Art. 18 / GDPR Art. 17 exigem direito de erasure. Retenção indefinida é ilegal e cara.

### Decisão
| Categoria | Retenção |
|---|---|
| `events` brutos | 13 meses |
| `dispatch_attempts` | 90 dias |
| Logs estruturados | 30 dias |
| `raw_events` (após processado) | 7 dias |
| PII enc | até erasure ou inatividade > 36 meses |
| `lead_consents` | permanente (prova de consentimento) |
| `audit_log` | 7 anos |

Endpoint `DELETE /v1/admin/leads/:lead_id` dispara job de anonimização (ver `planejamento.md` 10.1 para procedimento exato).

### Consequências
- (+) Conformidade legal explícita e auditável.
- (−) Job de purge precisa ser confiável e testado.

### Impacta
Todos os módulos que armazenam dado pessoal. `BR-PRIVACY-*`.

---

## ADR-015 — First-touch por `(lead_id, launch_id)`

### Status
Aceito.

### Contexto
Workspace pode rodar múltiplos lançamentos. Lead aparece em lançamento A, depois em lançamento B. First-touch deve ser por lançamento (cada lançamento conta sua própria origem) ou por workspace (uma origem para todo lifetime do lead)?

### Decisão
First-touch é por `(lead_id, launch_id)`. Lead que reaparece em outro lançamento recebe novo first-touch para esse lançamento. Last-touch é igualmente por lançamento, atualizado a cada conversão dentro dele.

### Alternativas consideradas
- First-touch global (workspace): perde granularidade comercial — operador quer saber qual campanha trouxe o lead **para este lançamento**.

### Consequências
- (+) Métricas de aquisição por lançamento são corretas e isoladas.
- (−) Schema `lead_attribution` tem `launch_id`; lookups precisam filtrar.

### Impacta
`MOD-ATTRIBUTION`, `BR-ATTRIBUTION-*`, dashboard rollups.

---

## ADR-016 — TypeScript estrito + Zod em fronteiras

### Status
Aceito.

### Contexto
Tracking errado destrói atribuição e decisões de mídia. Bug de tipo em produção custa caro. Validação em runtime (Zod) é segunda camada após `tsc`.

### Decisão
- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`.
- Zod em **todas** as fronteiras: HTTP request body, webhook payload, queue message, jsonb columns lidos.
- `any` proibido sem `// eslint-disable-next-line` + razão.
- Erros esperados modelados como valores (`Result<T, DomainError>`); exceções só para falhas inesperadas.

### Consequências
- (+) Bugs de fronteira raros.
- (−) Mais código boilerplate. Mitigação: schemas Zod compartilhados em `packages/shared/src/contracts/`.

### Impacta
Repositório inteiro. `25-convenções` do `planejamento.md`.

---

## ADR-017 — Conventional Commits em inglês; UI em português

### Status
Aceito.

### Contexto
Time é brasileiro mas referências (Stack Overflow, documentação, libraries) são em inglês.

### Decisão
- Identificadores de código em inglês (nomes de função, tipos, variáveis).
- Mensagens de commit em inglês (Conventional Commits).
- Comentários explicando "por quê" — em inglês.
- Documentação canônica (`docs/**`): português (já decidido — preserva acessibilidade ao operador).
- Copy de UI: português.
- Mensagens de erro técnicas em logs: inglês. Mensagens visíveis ao usuário: português.

### Consequências
- (+) Code review e onboarding alinhados com convenção da indústria.
- (+) Operadores brasileiros entendem docs e UI.

### Impacta
Todo repositório.

---

## ADR-018 — Metabase consulta views/rollups, não tabelas quentes

### Status
Aceito.

### Contexto
Metabase rodando queries pesadas direto em `events` (alta cardinalidade) degrada ingestão. Operador faz "SELECT * FROM events WHERE ..." sem entender particionamento.

### Decisão
- `events` é particionada por tempo, retenção 13 meses.
- Camadas analíticas separadas: `fact_funnel_events` (view), `daily_funnel_rollup` (materialized view), `ad_performance_rollup`, `audience_health_view`, `dispatch_health_view`, `audit_log_view`.
- Metabase expõe **apenas** views e rollups. Acesso direto a `events` requer credencial admin separada.

### Consequências
- (+) Performance previsível para dashboards.
- (+) Schema de produção pode evoluir sem quebrar dashboards (views absorvem mudança).
- (−) Rollups precisam de refresh schedule. Mitigação: CF Cron Trigger.

### Impacta
`MOD-EVENT`, `10-architecture/03-data-layer.md`, `22-analytics` do planejamento.

---

## ADR-019 — Webhook `event_id` derivado de `platform_event_id`

### Status
Aceito.

### Contexto
Hotmart, Stripe, Kiwify reenviam webhook se não receberem 2xx. Sem idempotência, retry cria duplicata em `events`.

### Decisão
```
event_id = sha256(platform || ':' || platform_event_id)[:32]
```

Combinado com `unique (workspace_id, event_id)` em `events`, retry cai na constraint e adapter retorna idempotente.

### Consequências
- (+) Idempotência transparente sem lógica adicional no adapter.
- (−) Depende do `platform_event_id` ser estável e único na origem. Verificado por adapter: Hotmart usa `transaction.code`; Stripe usa `event.id`; Kiwify usa `order.id` + `event_type`.

### Impacta
Todos adapters em `40-integrations/`.

---

## ADR-020 — Clamp de `event_time` no Edge

### Status
Aceito.

### Contexto
Cliente envia `event_time` baseado no relógio local. Relógios podem ter horas/dias de offset. Meta CAPI rejeita eventos com `event_time` > 7 dias. Sistema precisa decidir entre confiar no cliente ou clampar.

### Decisão
Edge aplica:
```
if abs(event_time - received_at) > EVENT_TIME_CLAMP_WINDOW_SEC: event_time = received_at
```
Default `EVENT_TIME_CLAMP_WINDOW_SEC=300` (5min). Métrica `event_time_clamps` registra ocorrências para detectar problemas sistemáticos.

### Consequências
- (+) CAPI nunca recebe timestamp inválido.
- (−) Eventos legítimos com offline-buffer > 5min têm `event_time` reescrito. Mitigação: tracker pode marcar `was_buffered=true` em `custom_data` para análise.

### Impacta
`MOD-EVENT`, `apps/edge/src/lib/event-time-clamp.ts`, `BR-EVENT-*`.

---

## ADR-021 — Replay protection com TTL 7 dias

### Status
Aceito.

### Contexto
Atacante pode capturar payload válido e reenviar para criar eventos falsos. Janela de proteção precisa ser longa o suficiente para cobrir reenvios legítimos (network retry, offline buffer) mas curta para limitar custo de armazenamento.

### Decisão
- `event_id` aceito é cacheado em CF KV com TTL 7 dias (alinhado com janela CAPI).
- Reenvio com mesmo `event_id` retorna `{status: "duplicate_accepted"}` sem criar novo `events` row.
- Purge é incremental via TTL natural do KV.

### Consequências
- (+) Cobre cenários legítimos de replay (offline buffer, network).
- (−) KV tem custo proporcional a eventos únicos × 7 dias. Mitigação: TTL natural elimina manutenção.

### Impacta
`MOD-EVENT`, KV binding `KV_REPLAY_PROTECTION`.

---

## ADR-022 — Stripe webhook signature: `constructEvent` + tolerância 5min + tempo-constante

### Status
Aceito.

### Contexto
Stripe usa esquema próprio de assinatura (`Stripe-Signature` com timestamp + HMAC). Implementação naive (string-equal) abre adapter a timing attacks; ausência de tolerância de timestamp permite replay infinito.

### Decisão
- Adapter Stripe usa `stripe.webhooks.constructEvent()` (raw body + signature header + endpoint secret).
- Tolerância anti-replay: 5 minutos sobre o timestamp do header.
- Comparação de assinatura via `crypto.timingSafeEqual`.
- Falha → retorna 400 sem detalhar erro ao caller.

### Consequências
- (+) Conforme à recomendação oficial Stripe.
- (+) Imune a timing attacks.

### Impacta
`40-integrations/09-stripe-webhook.md`, `apps/edge/src/routes/webhooks/stripe.ts`.

---

## ADR-023 — Page token rotation com janela de overlap

### Status
Aceito.

### Contexto
`page_token` está em HTML público de LPs externas (potencialmente em propriedade de terceiros). Rotação imediata quebraria todos snippets em produção.

### Decisão
- `page_tokens.status` ∈ {`active`, `rotating`, `revoked`}.
- Rotação cria novo token `active` e marca antigo como `rotating` por janela `PAGE_TOKEN_ROTATION_OVERLAP_DAYS` (default 14).
- Tokens `rotating` ainda são aceitos pelo Edge mas geram métrica `legacy_token_in_use` para alertar.
- Após janela, antigo vai para `revoked`.
- Revogação imediata (incidente de segurança) bypassa janela.

### Consequências
- (+) Operador tem 14 dias para atualizar snippets sem downtime.
- (+) Revogação emergencial ainda disponível.

### Impacta
`MOD-PAGE`, `BR-PAGE-*`, Control Plane (Fase 4).

---

## ADR-024 — Bot mitigation em `/v1/lead`: Cloudflare Turnstile

### Status
Aceito (2026-05-01).

### Contexto
`/v1/lead` aceita submissões públicas de email/phone. Sem mitigação, bots podem poluir a base de leads desde o dia 1 de produção, gerando ruído nos dispatches para Meta CAPI e Google Ads. OQ-004.

### Alternativas consideradas
- **(a) Honeypot + timing:** campo oculto + tempo mínimo de preenchimento. Zero dependência externa, mas não bloqueia bots sofisticados que inspecionam o DOM.
- **(b) Cloudflare Turnstile:** widget CF, gratuito, integra nativamente com Workers via `TURNSTILE_SECRET_KEY` binding. Valida token no server-side em < 5ms. Degrada para "pass" em rede instável (challenge-less mode configurável).
- **(c) reCAPTCHA v3:** dependência Google, latência extra, complicador LGPD (cookie de terceiro).

### Decisão
**Cloudflare Turnstile** como camada principal de bot mitigation em `/v1/lead`.

- O `tracker.js` renderiza o widget Turnstile invisível (`0x4AAAAAAA...`) no momento do submit do formulário de lead.
- O Edge valida `cf-turnstile-response` via `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` antes de inserir em `raw_events`.
- Token inválido → 403 `{ error: 'bot_detected' }`.
- Token ausente em `ENVIRONMENT=development` → bypass (dev não precisa do widget).
- **Honeypot** fica como backlog: campo `<input name="website" style="display:none">` no formulário — implementar em Sprint posterior como camada complementar barata.

### Consequências
- (+) Proteção efetiva desde o dia 1 de produção sem adicionar fricção ao usuário (Turnstile invisível).
- (+) Nativo no ecossistema CF — mesma conta, zero custo, latência de validação mínima.
- (-) Exige snippet extra no `tracker.js` (widget script da CF) e binding `TURNSTILE_SECRET_KEY` no Worker.
- (-) Honeypot adiado — bots muito simples (sem JS) passam até o honeypot ser implementado. Aceitável: bots sem JS também não disparam eventos Meta/Google úteis.

### Impacta
`apps/tracker/` (widget), `apps/edge/src/routes/lead.ts` (validação server-side), `wrangler.toml` (binding `TURNSTILE_SECRET_KEY`). Implementação: Sprint 2.

---

## ADR-025 — dispatch-replay: criar novo job filho (Opção A)

### Status
Aceito (2026-05-02). Fecha OQ-013.

### Contexto
`POST /v1/dispatch-jobs/:id/replay` tinha divergência: o contrato previa criação de novo job filho com `replayed_from_dispatch_job_id`; a implementação resetava o job existente (perdia histórico de tentativas).

### Alternativas consideradas
- **(Opção A):** criar novo `dispatch_job` com `replayed_from_dispatch_job_id = original_id`. Preserva histórico completo. Requer migration.
- **(Opção B):** manter reset do job existente. Mais simples, sem migration. Histórico perdido.

### Decisão
**Opção A.** Histórico completo de tentativas é essencial para diagnóstico (BR-AUDIT-001). Coluna `replayed_from_dispatch_job_id uuid NULL` adicionada em migration 0026.

### Consequências
- (+) Rastreabilidade completa: cada replay é um job distinto com seus próprios `dispatch_attempts`.
- (+) Sem breaking change — contrato já estava correto.
- (-) Migration 0026 adiciona coluna nullable (impacto mínimo).
- (-) Route refatorada para criar novo job em vez de resetar.

### Impacta
`packages/db/src/schema/dispatch_job.ts` · `packages/db/migrations/0026_test_mode_replay.sql` · `apps/edge/src/routes/dispatch-replay.ts` · `apps/edge/src/lib/dispatch.ts`.

---

## ADR-026 — Realinhamento template `lancamento_pago_workshop_com_main_offer` ao fluxo operacional real (Sprint 12)

### Status
Aceito (2026-05-04).

### Contexto
O template `lancamento_pago_workshop_com_main_offer` (seed em `0029_funnel_templates.sql`) foi desenhado na Fase 2 antes de existir um lançamento real validando-o. O E2E usability test do `wkshop-cs-jun26` (Outsiders Digital, sessão de 2026-05-04) revelou divergências estruturais entre o template e o fluxo operacional efetivamente praticado pelo operador:

- Template assumia múltiplas aulas (`watched_class_1/2/3`), mas o workshop real é evento único.
- Template esperava `InitiateCheckout` client-side em pages de venda; na prática, o checkout vive no Digital Manager Guru e o sinal de IC só é capturável via webhook (a investigar em sprint futuro).
- Template não previa stage de `survey_responded`, mas a `obrigado-workshop` real é uma página de pesquisa antes do botão WhatsApp.
- Template não previa page de aula separada; a aula precisa de uma `aula-workshop` (role=`webinar`) com tracking próprio.
- `event_config` defasado: faltava `Lead` na page de captura, faltavam `Contact` + `survey_responded` na thankyou, e `oferta-principal` esperava `InitiateCheckout` que não existe client-side.

Sprint 12 fecha o gap atualizando o template canônico (v2) e realinhando o launch real `wkshop-cs-jun26` para a forma nova.

### Decisão
- **D1.** `InitiateCheckout` (workshop e main) virá do Guru — load do checkout ou webhook intermediário, **a investigar pós-sprint**. IC fica fora dos stages do template Sprint 12; entra como input futuro para dispatcher Meta CAPI.
- **D2.** Após `Purchase` do workshop, lead é redirecionado para `obrigado-workshop`, que muda de papel para **página de pesquisa + botão WhatsApp ao final**. Fluxo: `Purchase` → `custom:survey_responded` → `Contact` (clique no botão WhatsApp).
- **D3.** Aula vive em page nova `aula-workshop` (role=`webinar`); MVP é binário com botão "Já assisti". Evolução planejada (Zoom webhook attendance ou heartbeat Vimeo) fica em backlog.
- **D4.** Tracking da aula é **binário** (`custom:watched_workshop` → 1 stage `watched_workshop`). Sem granularidade `_25/_50/_90` por enquanto.
- **D5.** Click "Quero Comprar" antes da popup de captura vira stage `clicked_buy_workshop` via `custom:click_buy_workshop`. Custom event client-side; iOS funciona via first-party fetch ao Edge Worker (cookie `__ftk` cross-origin já resolvido com `SameSite=None; Secure`).
- **D6.** `oferta-principal` **sem popup**; `clicked_buy_main` vem de `custom:click_buy_main` no botão da page main. Page main perde `Lead` do `event_config` e ganha o custom event de intent.

### Alternativas consideradas
- **Manter template original e tratar diferenças por workspace override**: viável tecnicamente, mas força cada operador a recriar a forma "real" — perde valor do template canônico. Rejeitado.
- **Tentar capturar IC client-side via redirect intermediário**: complexo (reverse-proxy do checkout Guru), depende do plano Guru e quebra UX. Adiado para investigação posterior.
- **Granularidade de aula via heartbeat já no MVP**: requer player embedded controlado; LP atual usa redirect externo. Rejeitado para MVP — backlog.

### Consequências
- (+) Template v2 reflete fluxo operacional real; novos lançamentos partem de blueprint validado em produção.
- (+) Custom events (`custom:*`) cobrem intents (`click_buy_*`) sem depender de IC do provider — reduz surface de falha.
- (+) Page `aula-workshop` separada permite evoluir tracking de attendance no futuro sem alterar pages de venda.
- (−) Stages de `InitiateCheckout` (workshop e main) ficam **fora** do template Sprint 12; investigação Guru webhook fica como ADR/Sprint futuro (potencial Sprint 14, ADR-027 ou seguinte).
- (−) Tracking de aula é binário e tem viés (operador pode clicar sem assistir); evolução para Zoom webhook ou Vimeo heartbeat planejada — fora do MVP.
- (−) `oferta-principal` perde `Lead` do `event_config` (não há popup); ganho de `custom:click_buy_main` é compensação parcial — leads que chegam à oferta principal sem ter passado pelo workshop ficam anônimos até IC do Guru (D1).
- (−) Migration `0031` precisa ser idempotente e preservar `lead_stages` históricos; já é critério da T-FUNIL-030.

### Impacta
`MOD-FUNNEL`, `MOD-LAUNCH`, `MOD-PAGE`, template seed em `packages/db/migrations/0031_funnel_template_paid_workshop_v2.sql`, doc canônica em [`docs/20-domain/06-mod-funnel.md`](../20-domain/06-mod-funnel.md), [`docs/20-domain/02-mod-launch.md`](../20-domain/02-mod-launch.md), [`docs/20-domain/03-mod-page.md`](../20-domain/03-mod-page.md), e [`docs/80-roadmap/funil-templates-plan.md`](../80-roadmap/funil-templates-plan.md). Sprint de execução: [`docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md`](../80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md). Investigação IC via Guru entra como ADR futuro (ADR-027 ou seguinte).

### Refinamento pós-implementação (2026-05-04) — Reorder cronológico de stages

Durante validação no Control Plane do template v2 já aplicado em produção, o operador detectou que a ordem dos dois primeiros stages contradiz o fluxo cronológico real:

- **Ordem original (v2 inicial):** `lead_workshop` (1) → `clicked_buy_workshop` (2) → ...
- **Ordem alvo (cronologicamente correta):** `clicked_buy_workshop` (1) → `lead_workshop` (2) → ...

**Justificativa:** no fluxo real (validado em `wkshop-cs-jun26`), o lead clica o botão **"Quero Comprar"** **antes** que a popup de captura abra e o form seja preenchido. Logo, `clicked_buy_workshop` é a porta de entrada do funil; `lead_workshop` ocorre **após** o submit do form. Forma cronológica reflete intenção operacional do operador para análises de funil (taxas de conversão "intent → form fill") e para futura semântica de `stage_gte` (T-FUNIL-040).

**Aplicação:**
- Migration `0032_reorder_stages_paid_workshop_v2.sql` (idempotente, espelhada em `supabase/migrations/`): swap de `blueprint.stages[0]` e `blueprint.stages[1]` no `funnel_templates` (template canônico) e em `launches.funnel_blueprint` dos snapshots já existentes do template.
- Re-run da migration é noop (verifica estado pré e alvo).
- **Sem regressão funcional:** nenhuma das 6 audiences do template usa `stage_gte` com `lead_workshop` ou `clicked_buy_workshop`; matching por `event_name` em `BlueprintStage.source_events` é independente de ordem (BR-EVENT-001).
- **Sem regressão de dados:** `lead_stages` históricos preservados (a migration não toca instâncias).

**Status:** ADR-026 permanece **Aceito**; este refinamento é um ajuste cronológico interno à decisão original (D5 — `clicked_buy_workshop` via custom event), não nova decisão arquitetural. Nenhum impacto em outras BRs/INVs/contracts.

---

## ADR-027 — `null=tombstone` em PATCH de configs JSONB

### Status
Aceito (2026-05-06). Aplicável genericamente a qualquer `PATCH /v1/...` sobre coluna JSONB; primeira aplicação em `PATCH /v1/workspace/config` (commit `b053c27`).

### Contexto
A UI do Control Plane precisa permitir **remover** entries individuais de records aninhados (`Record<string, V>`) dentro do `workspaces.config` — caso concreto: deletar uma campanha do `sendflow.campaign_map` sem reenviar o map inteiro. Opções de semântica para PATCH:

- **(A)** Sempre reenviar o map completo (replace de objeto inteiro). Quebra o princípio de PATCH parcial — clientes precisam ler antes de escrever, propenso a race entre dois operadores.
- **(B)** Endpoint dedicado `DELETE /v1/.../campaign_map/:id`. Multiplica superfície de API por cada `Record<>` aninhado. Não escala — `workspaces.config` tem múltiplos mapas (`integrations.guru.product_launch_map`, `sendflow.campaign_map`, e crescerão).
- **(C)** Convenção `null=tombstone`: enviar `null` no path da chave a remover, deep-merge interpreta como "delete". RFC 7396 (JSON Merge Patch) usa exatamente esta convenção como padrão.

### Decisão
**Opção C — `null=tombstone`.** Em qualquer `PATCH` sobre configs JSONB no Edge, valores `null` no body — em qualquer profundidade — fazem o `deepMerge` **deletar** a chave correspondente do objeto armazenado.

Implementação canônica em `apps/edge/src/routes/workspace-config.ts`:

```ts
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === null) {
      delete result[key]; // tombstone — deleta a chave
    } else if (isPlainObject(patchVal) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result;
}
```

Schemas Zod que aceitam `null` em values devem usar `.or(z.null())` explícito (ex.: `z.record(SendflowCampaignEntrySchema.or(z.null()))`).

### Alternativas consideradas
- **(A) Replace inteiro** rejeitado por inviabilizar concorrência segura entre operadores no CP.
- **(B) Endpoints `DELETE` dedicados** rejeitado por explosão combinatória de rotas (cada `Record<>` aninhado precisaria de uma).
- **Sentinela string** (e.g., `"__DELETE__"`) rejeitada por confusão com valores legítimos e perda de tipagem.

### Consequências
- (+) PATCH parciais expressivos sem inflar superfície de API.
- (+) Alinhado com RFC 7396 (JSON Merge Patch) — convenção amplamente conhecida.
- (+) Generaliza: qualquer config JSONB futura (e.g., `audiences.config`, `pages.event_config`) pode adotar a mesma semântica sem nova decisão.
- (−) Operadores precisam saber que `null` é destrutivo. Mitigação: documentado explicitamente em [`docs/30-contracts/05-api-server-actions.md`](../30-contracts/05-api-server-actions.md) com exemplos; UI do CP nunca envia `null` acidentalmente (sempre via ação explícita "Remover").
- (−) Não distingue entre "remover chave" e "definir chave como `null` literal". Aceito: configs do GlobalTracker não armazenam `null` literal em nenhum schema canônico; ausência de chave já é o estado "vazio".

### Impacta
- `apps/edge/src/routes/workspace-config.ts` (deepMerge — implementação canônica).
- `docs/30-contracts/05-api-server-actions.md` (`PATCH /v1/workspace/config`).
- Aplicável a futuros `PATCH` sobre configs JSONB (sem nova ADR — esta cobre).

---

## ADR-028 — Google Ads OAuth flow no Edge (não service account)

**Data:** 2026-05-06
**Status:** aceito
**Contexto:** Sprint 14 (fanout multi-destination conversion) precisa autenticar contra a Google Ads API pra (a) listar accessible customers, (b) enumerar conversion actions e (c) fazer upload de conversões offline + enhanced conversions. A Google Ads API exige OAuth 2.0 com `refresh_token` por conta — não aceita API key simples.

### Decisão
**OAuth 2.0 user flow completo no Edge (CP)**, com refresh_token criptografado por workspace via `encryptPii` (mesmo `PII_MASTER_KEY_V1`+HKDF). Workspaces conectam via botão "Conectar Google Ads" → redirect ao consent screen → callback grava token. `getGoogleAdsAccessToken(workspaceId)` faz cache em-memória (5min TTL) e auto-refresh.

**Onde armazenar (refinado 2026-05-06 durante T-14-002)**: refresh_token criptografado vai em **coluna dedicada `workspace_integrations.google_ads_refresh_token_enc`** (text nullable), seguindo o padrão pré-existente de `guru_api_token` e `sendflow_sendtok`. Restante da config (customer_id, login_customer_id, conversion_actions, oauth_token_state, enabled) vai em `workspaces.config.integrations.google_ads` (JSONB, sob Zod do PATCH `/v1/workspace/config`). Developer token (credencial operador GlobalTracker) vai em coluna `workspaces.google_ads_developer_token` ou env var fallback.

Razões: (a) consistência com convenção projeto (segredos opacos em coluna dedicada de `workspace_integrations`, config visível em JSONB), (b) GET /v1/workspace/config nunca expõe ciphertext acidentalmente, (c) length constraint SQL nativo (50-2048).

### Alternativas consideradas
- **Service account com domain-wide delegation**: rejeitado — Google Ads API **não suporta** service accounts diretamente (requer Google Workspace + delegation indireta via OAuth ainda assim).
- **Refresh token manual colado em form**: rejeitado como permanente — operadores não têm como gerar refresh_token sem rodar script local. Aceitável só pra dev (não bloqueia o sprint).

### Consequências
- (+) Autosserviço — outros workspaces conectam sem intervenção do dev.
- (+) Refresh token criptografado workspace-scoped reutiliza infra de PII existente (BR-PRIVACY-001).
- (+) Token rotation automatizado; `invalid_grant` força workspace para `oauth_token_state='expired'` + UI prompt pra reconectar.
- (−) OAuth flow exige callback URL fixo registrado no Google Cloud Console — adicionar `https://app.globaltracker.com.br/v1/integrations/google/oauth/callback` (ou domínio do Edge prod) na lista de Authorized redirect URIs.
- (−) Refresh tokens podem ser revogados unilateralmente pelo Google em casos de abuse — handler precisa lidar e expor estado pra UI.

### Impacta
- `apps/edge/src/routes/integrations-google.ts` (start + callback).
- `apps/edge/src/lib/google-ads-oauth.ts` (helper de access_token).
- `apps/control-plane/src/app/(app)/integrations/google-ads/page.tsx` (UI do flow).
- `apps/edge/src/routes/workspace-config.ts` (Zod `google_ads.*` no IntegrationsSchema — sem refresh_token).
- `packages/db/src/schema/workspace_integrations.ts` (`googleAdsRefreshTokenEnc`).
- `packages/db/src/schema/workspace.ts` (`googleAdsDeveloperToken`).
- `packages/db/migrations/0038_google_ads_secrets.sql`.
- `docs/40-integrations/03-google-ads-conversion-upload.md` (doc canônica).

---

## ADR-029 — Data Manager API como default para Customer Match (Sprint 16)

**Data:** 2026-05-06
**Status:** aceito (override de ADR-012 para workspaces novos)
**Contexto:** ADR-012 já formalizava "Customer Match Google: estratégia condicional" com 3 paths (`google_data_manager`, `google_ads_api_allowlisted`, `disabled_not_eligible`). Pra Sprint 16 (Custom Audiences + Customer Match), precisa fechar qual é o default pra workspaces novos.

### Decisão
**Data Manager API é o default** para workspaces criados pós-2026-04. Workspaces com allowlist legacy `google_ads_api_allowlisted` continuam no caminho antigo até deprecation forçado pelo Google. `disabled_not_eligible` segue como fallback automático em erro `CUSTOMER_NOT_ALLOWLISTED`.

### Alternativas consideradas
- **Manter Google Ads API legacy como default**: rejeitado — Google está migrando ofertas pra Data Manager; novos clientes não conseguem allowlist do path legacy.
- **Forçar migração imediata de workspaces antigos**: rejeitado — sem benefício técnico imediato e Google ainda mantém compat dual.

### Consequências
- (+) Alinhado com direção do Google (anúncios públicos 2025-Q4 sobre Data Manager prevalence).
- (+) Workspaces novos não esbarram em allowlist application time.
- (−) Dispatcher `audience-sync/google` precisa manter os dois clients vivos (já tem `strategy.ts` com switch).
- (−) Schema de erro entre as duas APIs é diferente — handler de erro deve mapear para o mesmo enum `audience_sync_error_code` interno.

### Impacta
- `apps/edge/src/dispatchers/audience-sync/google/strategy.ts` (default switch).
- `docs/40-integrations/05-google-customer-match.md` (doc canônica).
- `docs/90-meta/04-decision-log.md` (esta ADR; ADR-012 vira referência).

---

## ADR-030 — Custom events em Google Ads ficam como pendência manual (FUTURE-001)

**Data:** 2026-05-06
**Status:** aceito (limita escopo do Sprint 14)
**Contexto:** O tracker captura eventos custom canonical-prefixed (`custom:click_buy_workshop`, `custom:click_wpp_join`, `custom:survey_responded`, `custom:wpp_joined`, etc). Pra Meta CAPI eles vão como custom event direto. Pra GA4, idem (custom event no measurement). Mas Google Ads Conversion Upload **só aceita** `conversion_action_id`s pré-cadastradas no painel Google Ads — não há "custom event" automático.

### Decisão
**Sprint 14 cobre só eventos canonical** (Lead, Purchase, InitiateCheckout, ViewContent, AddToCart, CompleteRegistration, Subscribe, etc) na UI de mapping → conversion_action. Eventos custom ficam fora do MVP.

Schema permanece extensível: `workspaces.config.integrations.google_ads.conversion_actions` é `Record<event_name, conversion_action_id>` — operador pode adicionar `custom:click_buy_workshop` no JSONB cru hoje (sem UI), pra teste manual ou edge cases.

### Alternativas consideradas
- **UI completa per-launch para mapear todo custom event a uma conversion_action**: rejeitado — explosão combinatória, UX confusa, exige cadastro manual no painel Google primeiro (não tem como pré-popular dropdown sem operador criar conversion_action lá antes). Reabrir como FUTURE-001 quando houver demanda concreta.
- **Pular Google Ads conversion totalmente**: rejeitado — perde sinal pra remarketing dos eventos canonical principais.

### Consequências
- (+) Sprint 14 fecha com escopo definido (~1 semana).
- (+) Upgrade futuro pra custom events não exige migration — só UI nova.
- (−) Eventos como `custom:click_wpp_join` (alta intenção) **não** alimentam Google Ads conversion automaticamente. Pra remarketing baseado nesses, operador depende de Custom Audiences (Sprint 16) ou do GA4 (que aceita custom event nativamente).
- (−) Confusão UX possível — operador vê "Lead" mapeado mas não acha "click_wpp_join". Mitigação: copy explícito na UI ("Eventos custom não suportados — use audiences").

### Impacta
- `docs/80-roadmap/14-sprint-14-fanout-google-ads-ga4.md` (escopo).
- `apps/control-plane/src/app/(app)/integrations/google-ads/page.tsx` (lista de eventos no dropdown — só canonical).
- `apps/edge/src/lib/raw-events-processor.ts` (Step 9 wiring usa allowlist canonical).
- Pendência futura: **FUTURE-001** — UI per-launch pra custom events → conversion_action.

---

## ADR-031 — Meta CAPI: external_id em plano, IP/UA persistidos em events.userData, eligibility relax (Sprint 16)

**Data:** 2026-05-07
**Status:** Aceito (atualiza BR-PRIVACY-001)

### Contexto
EMQ (Event Match Quality) baixo de eventos anônimos no Meta Events Manager. Cenário operacional do GlobalTracker tem ad-blocker rate ~30% no Brasil, o que significa que PageView/ViewContent dispatched só por CAPI (sem Pixel browser pareando) ficam com `match_quality_score` baixo — Meta classifica como "good" só quando tem múltiplos sinais. Audiences de retargeting baseadas em PageView anônimo ficam incompletas porque `checkEligibility` skippava o evento com `skip_reason='no_user_data'` quando lead não tinha `em`/`ph`/`fbc`/`fbp` populados — mesmo que o cookie `__fvid` (visitor_id UUID v4) existisse desde a primeira visita.

Investigação técnica revelou três alavancas para destravar:

1. **`external_id` em plano**: `visitor_id` (UUID v4 random gerado pelo tracker, salvo no cookie `__fvid`) já existe em `events.visitor_id` desde Sprint 1 (ADR-007 — coluna reservada). Meta CAPI aceita `user_data.external_id` que ela hashea internamente; mandar plano permite debug direto no Events Manager (filtra por external_id) e cross-reference IP+UA → login Facebook do mesmo device (mecanismo de match interno do Meta).

2. **IP/UA persistidos em `events.userData` JSONB**: BR-PRIVACY-001 original era restritiva — proibia IP/UA em qualquer payload persistido. Meta CAPI / Google Enhanced Conversions exigem `client_ip_address` + `client_user_agent` não-hasheados como sinais de match. Manter IP/UA só transient (in-memory durante request) impedia replay/dispatch tardio de eventos antigos.

3. **`visitor_id` como 5º sinal de eligibility**: combinada com (1) e (2), `checkEligibility` pode passar PageView anônimo com `__fvid` populado — o evento ainda agrega valor para retargeting porque Meta consegue match via external_id+IP+UA.

### Decisão
**Três mudanças coordenadas** (Sprint 16 Onda 1):

1. **Tracker permissivo com `__fvid`**: cookie `__fvid` é criado/lido salvo quando `consent.analytics='denied'` explicitamente. Default = `granted` (alinhado com `DEFAULT_CONSENT`). UUID v4 random não é PII e não exige consent estrito.

2. **`external_id` em plano**: `events.visitor_id` (UUID v4) é enviado direto em `user_data.external_id` no payload Meta CAPI — não hasheado. Justificativa: UUID random é não-determinístico e não-reversível; mandar plano simplifica debug e permite Meta hashear com salt próprio.

3. **IP/UA persistidos em `events.userData` JSONB** (não em `raw_events.headers_sanitized`): captura no `POST /v1/events` via `CF-Connecting-IP` + `User-Agent` headers, mescla em `payload.user_data.client_ip_address` / `.client_user_agent` antes do insert em `raw_events`. Atualiza BR-PRIVACY-001 — separação intencional: `events.userData` é payload consumível por dispatchers (incluindo IP/UA para EMQ); `raw_events.headers_sanitized` retém só metadata operacional do request (origin, cf_ray, content-type).

4. **Eligibility relax**: `checkEligibility` em `apps/edge/src/dispatchers/meta-capi/eligibility.ts` aceita `visitor_id` como 5º sinal válido (junto com `em`, `ph`, `fbc`, `fbp`). PageView anônimo com `__fvid` agora é dispatched (antes skipado com `no_user_data`).

### Alternativas consideradas
- **Hashear `visitor_id` antes de enviar como `external_id`**: rejeitado — duplica trabalho (Meta hashea de novo), perde debugability, e UUID random não é PII (não há ganho de privacidade).
- **Persistir IP/UA só em coluna dedicada `events.client_ip_enc` / `events.client_ua_enc` criptografada**: rejeitado — adiciona complexidade de schema, exige decrypt no dispatcher (overhead em path quente), e IP/UA são metadata de evento curto-vida que é descartada na erasure SAR junto com o resto.
- **Manter IP/UA transient (in-memory)**: rejeitado — impede replay de eventos antigos via `dispatch_jobs`, e re-dispatch após erro Meta CAPI (5xx, timeout) precisa de IP/UA originais para idempotência de match.
- **Não relaxar eligibility (manter exigência de em/ph/fbc/fbp)**: rejeitado — destrói valor de tracking de visitantes anônimos com ad-blocker, principal motivador da mudança.

### Consequências
- (+) Audiences de retargeting cobrem ~30% do tráfego ad-blocker que antes não chegava ao Meta via CAPI.
- (+) EMQ médio sobe — Meta passa a ter IP+UA+external_id mesmo em PageView anônimo (3 sinais).
- (+) Debug direto no Events Manager: filtra por `external_id` e correlaciona com `events.visitor_id` no DB.
- (+) BR-PRIVACY-001 fica explícita sobre separação `raw_events × events` — antes era restritiva genérica.
- (−) Volume de `dispatch_jobs` Meta CAPI aumenta (PageView anônimo agora dispatched). Em escala CNE/lançamentos pequenos é insignificante. Em workspace de alto volume (>1M PageView/dia) precisa monitorar EMQ médio + custo Workers + cota da Conversions API.
- (−) IP/UA persistidos em `events.userData` aumentam volume de retenção de PII pessoal (LGPD considera IP como dado pessoal). Mitigação: BR-PRIVACY-005 atualizada — `eraseLead` zera `client_ip_address`/`client_user_agent` junto com email/phone na SAR. Retenção de `events` continua 13 meses (ADR-014).
- (−) Operadores que tinham expectativa de "IP nunca é persistido" precisam ser comunicados via release note. Mitigação: documentado em BR-PRIVACY-001.

### Reversão
Trocar 1 linha em `apps/edge/src/dispatchers/meta-capi/eligibility.ts` (remover `visitor_id` do `hasIdentitySignal`) volta ao comportamento anterior de eligibility. Tracker e mapper permanecem (não causam dispatch isolado, só preparam dado). Para reverter persistência de IP/UA: remover merge em `apps/edge/src/routes/events.ts` e atualizar Zod `UserDataSchema` para rejeitar os campos.

### Impacta
- `apps/edge/src/dispatchers/meta-capi/mapper.ts` (`MetaUserData` + `DispatchableEvent` — popula `external_id` literal de `event.visitor_id`).
- `apps/edge/src/dispatchers/meta-capi/eligibility.ts` (5º sinal: `visitor_id`).
- `apps/edge/src/routes/events.ts` (captura `CF-Connecting-IP` + `User-Agent` e mescla em `payload.user_data`).
- `apps/edge/src/routes/schemas/event-payload.ts` (`UserDataSchema` aceita `client_ip_address` + `client_user_agent`).
- `apps/tracker/` (cookie `__fvid` permissivo).
- `docs/50-business-rules/BR-PRIVACY.md` (BR-PRIVACY-001 reescrita; BR-PRIVACY-005 atualizada).
- `docs/20-domain/05-mod-event.md` (§3 — campos permitidos em `events.userData`; INV-EVENT-004).
- `docs/40-integrations/01-meta-capi.md` (tabela user_data + eligibility).

---

## ADR-032 — GA4 client_id: cascata 4 níveis (fecha OQ-012) (Sprint 16)

**Data:** 2026-05-07
**Status:** Aceito

### Contexto
Compra via webhook Guru chega sem `_ga` cookie quando o comprador caiu direto no checkout sem passar pela LP (~10% dos casos no histórico CNE: auditoria 2026-05-07 mostrou 15/15 Purchase Guru históricos skipados com `no_client_id` e 0 dos respectivos leads tinham PageView prévio com `_ga`). OQ-012 propunha 4 alternativas (A: UUID random; B: skip; C: lookup `_ga` em PageView anterior do mesmo lead; D: configurável). Atual era B implícito.

### Decisão (Alternativa D combinada — cascata determinística 4 níveis)
1. **self**           — `resolveClientId(event.user_data)`.
2. **sibling**        — `_ga`/`fvid` de evento anterior do MESMO lead, com filtro `received_at < current.received_at` (evita inversão temporal).
3. **cross_lead**     — `_ga`/`fvid` de evento anterior de OUTRO lead do mesmo workspace com mesmo `phone_hash_external` (1ª) ou `email_hash_external` (2ª) — recupera caso pessoa tenha múltiplos leads não-mergeados.
4. **deterministic**  — client_id mintado de `SHA-256(workspace_id:lead_id)` → formato `GA1.1.<8d>.<10d>`. Mesmo lead sempre vira mesmo client_id no GA4, preservando continuidade cross-event.
5. **unresolved**     — só dispara skip quando `lead_id` ausente (caso raro).

Resolver permanece **puro** (sem I/O direto). DB lookups (níveis 2 e 3) acontecem em `buildGa4DispatchFn` antes da chamada.

### Alternativas descartadas
- **Alt A** (UUID random a cada evento) — distorce GA4: cada Purchase vira novo "user", quebrando continuidade de funnel.
- **Alt B** (skip silencioso) — atual; perde 15+ Purchases históricos no GA4 e quebra ROAS reportado.
- **Alt C isolada** (sibling-only) — não cobre o caso edge (compra direto sem LP).

### Consequências
- (+) 15 Purchases históricos podem ser reprocessados via re-enqueue dos `dispatch_jobs` `ga4_mp` (status=`skipped`/`no_client_id`) → vão `succeeded` com client_id determinístico.
- (+) Cross-event continuity: lead que compra workshop e depois main_offer aparece como mesmo "user" no GA4, ROAS calcula correto.
- (+) `skip_reason='no_client_id_unresolvable'` (em vez do genérico `no_client_id`) quando `lead_id` ausente — facilita debug.
- (−) Custo: até 2 queries extras por dispatch (sibling + cross_lead). Em escala de centenas/dia (CNE) é insignificante.
- (−) Pendente: re-enqueue dos 15 dispatch_jobs `ga4_mp` históricos pós-deploy (script ad-hoc `/tmp/pgquery/replay-ga4-purchase-skips.mjs`).

### Reversão
Trocar `resolveClientIdExtended` → `resolveClientId` (atual) em `buildGa4DispatchFn` restaura comportamento Alt B.

### Impacta
- `apps/edge/src/dispatchers/ga4-mp/client-id-resolver.ts` (`resolveClientIdExtended`, `mintDeterministicClientId`, tipos `ResolverInput`/`ResolverSource`/`ResolverResult`).
- `apps/edge/src/index.ts` (`buildGa4DispatchFn` — coleta sibling + cross_lead via DB).
- `apps/edge/src/dispatchers/ga4-mp/eligibility.ts` (comentário inline OQ-012 → ADR-032).
- `docs/40-integrations/06-ga4-measurement-protocol.md` (§3 cascata).
- `docs/90-meta/03-open-questions-log.md` (OQ-012 → FECHADA).

---

## ADR-033 — Geo enrichment: Cloudflare request.cf (browser) + Guru contact.address (Purchase) (Sprint 16)

**Data:** 2026-05-07
**Status:** Aceito

### Contexto
Events Manager Meta reporta possíveis +13% de EMQ por adicionar `ct/st/zp/country` (city, state, zip, country) em cada evento Lead/Purchase, e Google Enhanced Conversions aceita os mesmos campos via `addressInfo`. Não coletamos esses dados hoje no formulário CNE (cidade/estado/CEP/nascimento). Precisamos derivar do que já temos.

### Decisão
Geo enrichment em duas fontes complementares por tipo de evento:

1. **Eventos browser** (PageView, Lead, InitiateCheckout, custom:*) → Cloudflare `request.cf`:
   - `cf.city`, `cf.regionCode`, `cf.postalCode`, `cf.country` lidos em `routes/events.ts` junto com IP/UA.
   - Sem custo extra: o edge já roteia o request pela Cloudflare; geo é resolvido no mesmo objeto.
   - Acurácia: ~90% para `state`, ~70% para `city` (VPN/mobile carrier introduzem ruído).

2. **Eventos Purchase via Guru webhook** → `contact.address` do payload:
   - Schema do Guru estende `contact` com `.address.{city,state,zip_code,country}` (passthrough preserva quando ausente).
   - Acurácia 100%: é o endereço de cobrança real do comprador (Guru coleta para NF/fiscal).
   - Não usar `request.cf` para Purchase: o request vem do servidor do Guru, não do comprador.

3. **Storage canônico** em `events.userData`: campos `geo_city`, `geo_region_code`, `geo_postal_code`, `geo_country` (raw plain text). Cada dispatcher aplica sua normalização.

4. **Normalização por dispatcher**:
   - **Meta CAPI** (`ct/st/zp/country`): `hashPiiExternal` (SHA-256 puro) com normalização: city `lowercase().trim()`, state `lowercase()` (regionCode 2-letter), zip `replace(/\D/g, '')` (dígitos only), country `lowercase()` (ISO 3166-1 alpha-2). Hash acontece em `buildMetaCapiDispatchFn` (async) antes de chamar o mapper puro.
   - **Google Enhanced Conversions** (`addressInfo.{city,state,zipCode,countryCode}`): plain text — Google normaliza/hasheia internamente.

### Alternativas descartadas
- **API de geo externa** (MaxMind, ipapi) — custo recorrente sem ganho material vs Cloudflare. Cloudflare tem pop em SP/RJ/MIA com baixa latência e a mesma fonte (MaxMind GeoIP2) sob o capô.
- **Geo via tracker.js client-side** (`navigator.geolocation`) — exige permissão explícita do usuário, fricção UX altíssima para 13% de ganho.
- **Hashing geo no mapper Meta (puro)** — exigiria converter mapper para async ou inicializar crypto no construtor. Optamos por hashar no dispatch fn (já async) e passar pré-hasheado ao mapper puro (consistente com `email_hash_external` etc).
- **Storage paralelo separado por destino** (`geo_meta_hashed_*` + `geo_google_plain_*`) — duplica storage. Decisão: armazenar plain raw 1x e cada dispatcher derivar.

### Consequências
- (+) Lead/PageView/InitiateCheckout enviam ~+13% EMQ Meta + matching melhor Google Ads sem mudar nada no formulário.
- (+) Purchase com endereço real do comprador (`contact.address` Guru) — match rate Meta sobe especialmente em remarketing.
- (+) Zero custo operacional adicional: Cloudflare grátis, Guru já envia (passthrough capturava em raw_events.payload mas era ignorado).
- (−) `events.userData` cresce ~80 bytes por evento. Em 50k events/mês CNE = ~4MB/mês — desprezível.
- (−) BR-PRIVACY: geo via IP é considerado dado pessoal (LGPD art. 5º, IV). `eraseLead` precisa zerar `geo_*` junto com IP/UA na SAR (atualizar BR-PRIVACY-005).
- (−) Pre-existente: Guru `contact.address` aparece em alguns planos do Guru (NF habilitada). Quando ausente, geo do Purchase fica vazio. Não há fallback para `request.cf` (servidor Guru, não comprador).

### Reversão
Remover ramos `if (event.user_data?.ct)` etc nos mappers e o bloco de extração `cf` em `routes/events.ts`. Storage em events.userData fica órfão mas não quebra nada (campos são opcionais).

### Impacta
- `apps/edge/src/lib/raw-events-processor.ts` (`UserDataSchema` ganha 4 chaves canônicas).
- `apps/edge/src/routes/events.ts` (extração de `request.cf` + merge em `mergedUserData`).
- `apps/edge/src/lib/guru-raw-events-processor.ts` (`contact.address` no schema + `userData` populado).
- `apps/edge/src/dispatchers/meta-capi/mapper.ts` (`MetaUserData` + `DispatchableEvent.user_data` ganham `ct/st/zp/country`).
- `apps/edge/src/index.ts` `buildMetaCapiDispatchFn` (hash via `hashPiiExternal`).
- `apps/edge/src/dispatchers/google-enhanced-conversions/mapper.ts` (`addressInfo` ganha plain text + `DispatchableEvent` ganha `geo`).
- `apps/edge/src/index.ts` `buildEnhancedConversionDispatchFn` (passa `geo` raw).
- `docs/40-integrations/01-meta-capi.md` (§4 user_data canônicos: `ct/st/zp/country` SHA-256).
- `docs/40-integrations/04-google-ads-enhanced-conversions.md` (§4 addressInfo expandido).
- `docs/40-integrations/13-digitalmanager-guru-webhook.md` (`contact.address`).
- `docs/30-contracts/05-api-server-actions.md` (`/v1/events` POST: campos geo derivados server-side).
- `docs/50-business-rules/BR-PRIVACY.md` (geo entra na trilha de IP/UA na erasure).

---

## ADR-034 — Roles privilegiadas para PII em claro: ampliação para admin/marketer + reveal-on-demand para operator (Sprint 16)

**Data:** 2026-05-08
**Status:** Aceito

### Contexto

`BR-IDENTITY-006` original (AUTHZ-001) restringia decifragem de PII em claro a `privacy` e `owner`, com audit log obrigatório. Na operação real do GlobalTracker (CNE como primeiro cliente operacional), o role que efetivamente faz triagem de leads, suporte ao cliente e investigação de funil é `admin` e `marketer`. O constraint original criava fricção (toda consulta exigia troca de chapéu pra `privacy`) sem ganho de proteção concreto: `admin`/`marketer` são roles internos de equipe, não públicos.

Ao mesmo tempo, exibir 30+ emails+telefones em lote num scroll de leads é exposição massiva — o tipo que LGPD pune. Para roles operacionais inferiores (`operator`, `viewer`), faz sentido manter mascarado por padrão e exigir intenção consciente para revelar.

### Decisão

Matriz de acesso a PII em claro (`email`, `phone`, `name` permanece sempre visível pois deixou de ser PII protegido — ver §Storage abaixo):

| Role | Lista (`/v1/leads`) | Detalhe (`/v1/leads/:id`) | Audit |
|---|---|---|---|
| `owner` | claro | claro | (não — acesso natural) |
| `admin` | claro | claro | (não) |
| `marketer` | claro | claro | (não) |
| `privacy` | claro | claro | sim, sempre |
| `operator` | mascarado | mascarado + botão "Revelar PII" | sim, on reveal |
| `viewer` | mascarado | mascarado, sem reveal | n/a (sempre denied) |

**Mascaramento**:
- Email: `a***@gmail.com` (1ª letra + `***@` + domínio).
- Phone: `+55 11 9****-7777` (DDI + DDD + 9 + `****` + últimos 4 dígitos).

**Reveal-on-demand** (operator):
- Endpoint `POST /v1/leads/:public_id/reveal-pii` com body `{ reason: string }`.
- Grava `audit_log` com `action='read_pii_decrypted'`, `actor_id`, `target_lead_id`, `fields_accessed=['email','phone']`, `reason`.
- Retorna PII em claro no response.
- Front-end Control Plane usa o endpoint quando o usuário clica "Revelar PII" no detalhe do lead.

**Storage canônico de `name`**: ver migration 0041 — `name` deixa de ser cifrado (`name_enc`) e passa a ser plaintext em `leads.name` com índice `lower(name)` para search ILIKE. Justificativa: o nome não é PII de risco operacional (público em redes sociais, recibos, recibo de compra, NF), e a busca por nome é a feature mais pedida pra triagem. Email/phone permanecem cifrados em `email_enc`/`phone_enc` + hash determinístico em `email_hash`/`phone_hash` para search.

### Alternativas descartadas

- **Manter spec original** (`privacy`/`owner` apenas) — bloqueia operação real; usuário pediria troca de role o tempo todo.
- **Mascarar para todos por padrão + reveal on-demand pra todos** — fricção desnecessária para `admin`/`marketer` que respondem suporte ao cliente diariamente.
- **Manter `name` cifrado** — search por nome é a feature mais pedida; decifrar todos os leads em memória pra ILIKE não escala. Adicionar `name_hash` workspace-scoped não habilita busca por substring.

### Consequências

- (+) Operação real destravada: `admin`/`marketer` veem PII sem fricção.
- (+) Search por nome via ILIKE indexed (`lower(leads.name)`) — performance constante.
- (+) `operator` continua útil (vê funil + agregados) sem expor PII em massa; reveal pontual é auditável.
- (–) `name` deixa de ter cripto-defesa em depth (mas hash workspace-scoped não fazia diferença no nível de proteção real — chave é o mesmo `PII_MASTER_KEY_V1`).
- (–) Migration 0041 e backfill obrigatórios para popular `leads.name` a partir de `name_enc`.

### Implementação

- **Migration 0041**: adiciona `leads.name` text + index btree em `lower(name) varchar_pattern_ops` para ILIKE.
- **Backfill**: decifra `name_enc` via `decryptPii` para todos leads existentes; grava em `leads.name`.
- **Writers** (`lead-resolver`, `pii-enrich`, webhooks Guru/SendFlow/Hotmart/Stripe/Kiwify): gravar `leads.name` plaintext em paralelo com `name_enc` (deprecated, ainda lido por compat). Drop de `name_enc` fica para sprint futura.
- **Backend `listLeads`**: search detection — UUID/email-regex/phone-regex/else. Search por email/phone hash determinístico; por nome ILIKE.
- **JWT role extraction + RBAC enforcement**: depende do Sprint 6 RBAC concluir auth real (TODO existente em `routes/leads-timeline.ts:631`). Até lá, frontend retorna PII em claro pra todos. Reveal-on-demand entra como Fase 2.

### Doc afetada

- `docs/50-business-rules/BR-IDENTITY.md` BR-IDENTITY-006 (atualizar lista de roles).
- `docs/50-business-rules/BR-RBAC.md` BR-RBAC-002 (referência atualizada).
- `docs/00-product/03-personas-rbac-matrix.md` (matriz de roles).
- `docs/30-contracts/05-api-server-actions.md` (novo endpoint reveal-pii — Fase 2).

---

## ADR-035 — `lifecycle_status` armazenado em `leads` (vs derivado em query) (Sprint 16)

### Status
aceito.

### Contexto
Sprint 16 introduz o conceito de Lifecycle do Lead com 5 estados monotônicos (`contato → lead → cliente → aluno → mentorado`). Decisão de modelagem: persistir o estado em coluna direta de `leads`, ou derivá-lo em runtime (via JOIN com `events`/`products` em cada listagem)?

### Decisão
Persistir como coluna `leads.lifecycle_status NOT NULL DEFAULT 'contato'` (CHECK constraint para os 5 valores). `promoteLeadLifecycle` em pipeline mantém a coluna atualizada sempre que um Purchase é processado ou um Lead form é submetido.

### Alternativas consideradas
- **Derivar em query** via JOIN/MAX em `events`+`products` — evita coluna redundante mas exige JOIN multi-tabela em toda listagem (`/v1/leads`) e dashboard. Custo de leitura cresce com volume; cache invalidation complexo.
- **Materialized view** — atualização defasada, complica retenção e DLQ.

### Consequências
- (+) `GET /v1/leads` filtra/ordena por `lifecycle_status` sem JOIN — listagem rápida.
- (+) Filtro `?lifecycle=` no endpoint é trivial.
- (–) 1 UPDATE extra por Purchase (idempotente, no-op em downgrade — barato).
- (–) Backfill obrigatório quando categoria de produto muda (BR-PRODUCT-003).

### Impacta
MOD-IDENTITY (`leads.lifecycle_status`), MOD-PRODUCT (write-side), CONTRACT-api-leads-list-v1 (filter + response field).

---

## ADR-036 — Categorias de produto hardcoded no MVP, com migration path para tabela editável (Sprint 16)

### Status
aceito.

### Contexto
Mapeamento `ProductCategory → LifecycleStatus` é regra de negócio. No MVP precisa estar pronto rápido sem UI de configuração. Eventualmente operadores vão querer customizar (ex.: "minha mentoria de grupo de 12 meses promove para `mentorado`, não `aluno`").

### Decisão
Hardcoded no MVP em `apps/edge/src/lib/lifecycle-rules.ts` com 11 categorias canônicas + NULL fallback. **Mas** a função pública `lifecycleForCategory(workspaceId, category)` recebe `workspaceId` desde o início — preparada para migração futura para tabela `lifecycle_rules` por workspace **sem rewriting dos callers** (FUTURE-001).

### Alternativas consideradas
- **Tabela editável já no MVP** — cria UI extra, validação de consistency (ex.: workspace cadastra categoria que não existe), risk de inconsistency entre workspaces, slip de sprint.
- **Hardcoded sem `workspaceId` na assinatura** — força refactor de callers quando vier a tabela editável.

### Consequências
- (+) MVP entrega rápido com regra única e auditável.
- (+) Migração futura é local: trocar implementação de `lifecycleForCategory` para fazer SELECT em `lifecycle_rules` com fallback hardcoded — zero impacto nos call sites.
- (–) Workspaces que querem regra customizada precisam esperar FUTURE-001.

### Impacta
MOD-PRODUCT, BR-PRODUCT-001.

---

## ADR-037 — `launch_products` substitui `workspaces.config.integrations.guru.product_launch_map` (Sprint 16)

### Status
aceito.

### Contexto
Antes do Sprint 16 a relação produto↔launch (Guru) vivia em JSONB free-form em `workspaces.config.integrations.guru.product_launch_map: Record<external_product_id, { launch_public_id, funnel_role: string }>`. Problemas:
- `funnel_role` era string livre — inconsistência entre workspaces (um usa `main`, outro `principal`, outro `oferta`).
- Sem FK — produto deletado deixava entry órfã.
- Sem RLS dedicada — qualquer mudança em `workspaces.config` exigia rewrite do JSONB inteiro.
- Acoplado a Guru — Hotmart/Kiwify/Stripe replicariam o padrão, criando 4 maps paralelos.

### Decisão
Tabela tipada `launch_products(workspace_id, launch_id, product_id, launch_role)` com:
- `launch_role` enum `{main_offer, main_order_bump, bait_offer, bait_order_bump}` (ver `LaunchProductRole` em `01-enums.md`),
- UNIQUE `(launch_id, product_id)` — produto ocupa 1 role por launch,
- RLS `workspace_isolation`,
- API CRUD em `/v1/launches/:public_id/products/*`.

`guru-launch-resolver.ts` ganha **Strategy 0** (consulta `launch_products` JOIN `products` via `external_provider`+`external_product_id`) como fonte primária; legacy `product_launch_map` mantido como **Strategy 1 fallback** durante migração. Backfill aplicado para o workspace CNE em Sprint 16: 5 entries migradas (heurística: nome com prefix "Pack" → `bait_order_bump`; "workshop" no nome → `bait_offer`; demais → `main_offer`).

### Alternativas consideradas
- **Manter JSONB com schema validado** — não resolve problema de FK, RLS dedicada, ou múltiplos providers.
- **Tabela genérica `launch_external_products` com provider/external_id direto** (sem `products` separado) — perde o catálogo unificado; impossibilita lifecycle promote por categoria.

### Consequências
- (+) `launch_role` tipado elimina string drift.
- (+) Provider-agnostic: Hotmart/Kiwify/Stripe usam o mesmo `launch_products` quando seus webhooks também upsertarem em `products`.
- (+) UI mostra nome do produto (do `products.name`) em vez de raw `external_product_id`.
- (–) Custo de migração: backfill por workspace + manter Strategy 1 fallback até deprecation final (FUTURE-003).

### Impacta
MOD-PRODUCT, MOD-LAUNCH, MOD-FUNNEL (`guru-launch-resolver.ts`), CONTRACT-api-launch-products-*.

---

## ADR-038 — Helper `jsonb()` obrigatório em writes via Hyperdrive (Sprint 17, hardening 2026-05-09)

### Status
aceito.

### Contexto
Bug latente desde Sprint 1 e reportado em prod 2026-05-08 ao investigar EMQ Meta CAPI baixo: queries `WHERE user_data->>'fbc' IS NOT NULL` retornavam zero linhas mesmo com dados visíveis no Drizzle. Diagnóstico: o driver `pg-cloudflare-workers` por trás do binding `HYPERDRIVE` envia parâmetros de bind como text-com-aspas; sem cast explícito, Postgres aceita o valor em coluna `jsonb` como `jsonb_typeof='string'` (uma string JSON-encoded em vez de um objeto). Operadores `->`/`->>` sobre jsonb-string retornam NULL silenciosamente. Drizzle só recompõe o objeto via `JSON.parse` ao ler, mascarando o problema na camada TS.

### Decisão
Helper `jsonb(value)` em `apps/edge/src/lib/jsonb-cast.ts` que envolve o valor em SQL fragment dollar-quoted `$gtjsonb$<json>$gtjsonb$::jsonb` via `sql.raw`, forçando o cast text→jsonb antes do bind. **Todo write em coluna jsonb pelo edge worker** (`apps/edge/`) deve usar o helper:

```ts
await db.insert(events).values({
  user_data: jsonb(userData),     // ✓ cast forçado
  custom_data: jsonb(customData),
});
```

Aplicado em ~58 writes em 12 arquivos: 4 raw-events-processors (`raw-events-processor.ts`, `guru-raw-events-processor.ts`, `sendflow-raw-events-processor.ts`, `onprofit-raw-events-processor.ts`), `dispatch.ts`, `index.ts`, e 6 webhook adapters (`guru.ts`, `hotmart.ts`, `kiwify.ts`, `stripe.ts`, `sendflow.ts`, `onprofit.ts`). Commit `22db9a9` (deploy `ed9a490d`).

Reads precisam de parse defensivo `(col #>> '{}')::jsonb` (SQL) ou check `typeof row.col === 'string'` (TS) para tolerar rows legadas pré-deploy `ed9a490d`. View `v_meta_capi_health` (migration `0047`) exemplifica o padrão SQL.

### Alternativas consideradas
- **Drizzle config patch / fork** — cirurgia frágil, perde upstream updates.
- **Backfill em massa de rows legadas + assumir driver fix futuro** — não resolve o bug, apenas remenda dados.
- **Trocar driver para `postgres-js` direto** — perde Hyperdrive pool gerenciado; latência piora.
- **Criar Postgres trigger `BEFORE INSERT` que re-parse jsonb-string** — overhead em todo INSERT, esconde origem do bug.

### Consequências
- (+) Storage type correto desde write — queries SQL ad-hoc, indexes GIN expressional, e migrations funcionam sem cast defensivo nas escritas novas.
- (+) Padrão único e testável — helper `tests/helpers/jsonb-unwrap.ts` extrai JS value do SQL fragment para mocks de driver.
- (–) Code review exige verificar uso do helper em todo novo write — auditor precisa grep `db.insert.*jsonb_col_name` sem `jsonb(`.
- (–) Rows legadas (pré-deploy `ed9a490d`) seguem como jsonb-string — backfill em massa fica como tracking pending (`MEMORY.md §3 / JSONB-LEGACY-ROWS-BACKFILL`).

### Impacta
MOD-EVENT (`events.user_data/custom_data/attribution/consent_snapshot`), MOD-DISPATCH (`dispatch_jobs.payload_template`, `dispatch_attempts.request/response_payload_sanitized`), MOD-WORKSPACE (`workspaces.config`), todos os webhook adapters em MOD-EVENT.

---

## ADR-039 — `lookupHistoricalBrowserSignals` sem filtro temporal (Sprint 17, hardening 2026-05-09)

### Status
aceito.

### Contexto
Sprint 17 introduziu `lookupHistoricalBrowserSignals(db, workspace_id, lead_id)` em `apps/edge/src/index.ts` para enriquecer eventos de webhook (Guru/OnProfit/Hotmart/SendFlow) com `fbc`/`fbp`/`client_ip_address`/`client_user_agent`/`visitor_id` capturados em events anteriores do tracker.js — sem isso, Purchase events (o sinal monetário mais valioso) chegavam ao Meta CAPI com EMQ degradado (match score 4-5/8). Decisão de design: a query deve ou não filtrar `received_at < event_corrente.received_at`?

### Decisão
**Sem filtro temporal.** A query pega os 10 events mais recentes do lead independentemente da ordem cronológica vs o evento sendo dispatchado:

```sql
SELECT events.user_data, events.visitor_id
  FROM events
 WHERE workspace_id = $1
   AND lead_id = $2
   AND (visitor_id IS NOT NULL
        OR (user_data #>> '{}')::jsonb->>'fbc' IS NOT NULL
        OR (user_data #>> '{}')::jsonb->>'fbp' IS NOT NULL
        OR (user_data #>> '{}')::jsonb->>'client_ip_address' IS NOT NULL
        OR (user_data #>> '{}')::jsonb->>'client_user_agent' IS NOT NULL)
 ORDER BY received_at DESC
 LIMIT 10;
```

### Alternativas consideradas
- **Filtro `received_at < $event.received_at`** — semanticamente correto se assumirmos "passado causa presente", mas defeita o caso real:
  - Webhook Purchase chega antes do PageView "obrigado" no DB (race comum entre callback assíncrono Guru e redirect do checkout).
  - Replay de dispatch executado horas/dias depois do evento original cortaria todo o histórico acumulado entre original e replay.
  - Cookies `_fbc`/`_fbp` Meta têm refresh cycle de 90 dias — o valor mais fresco é mais útil que o valor mais antigo, mesmo que tecnicamente "futuro" relativo ao Purchase.
- **Filtro com janela tolerante** (ex.: `received_at < $event.received_at + INTERVAL '1 hour'`) — adiciona magic number, ainda corta replays e não traz benefício de qualidade demonstrável.

### Consequências
- (+) Match score sobe consistente de 4-5/8 para 7/8 em replays — validado em 7 Purchases Guru pós-deploy `ba2fbe37`.
- (+) Replays de dispatch_jobs continuam efetivos em janelas longas — não há "decay" do enrichment.
- (+) View `v_meta_capi_health` espelha exatamente o que o dispatcher real faz — observabilidade fiel.
- (–) **Trade-off de attribution**: lead que tenha passado por dois `fbclid` distintos em momentos diferentes (clicou num ad em janeiro, outro em maio, comprou em maio) terá o `fbc` mais recente atribuído ao Purchase. Aceitável para o caso de uso típico (workshop curto, ciclo 7-14 dias).
- (–) **Implicação para erasure**: enrichment server-side significa que IP/UA/`visitor_id` capturados em qualquer event do lead podem ser propagados para outros events no dispatch. `eraseLead` deve zerar esses campos em **todos** os events do lead, não só o atual (BR-PRIVACY-005 atualizada).

### Impacta
MOD-DISPATCH (orchestrator Meta CAPI), MOD-EVENT (storage de browser signals), MOD-IDENTITY (`erasure.ts` precisa de scope expandido), CONTRACT-api-events-v1 (não muda, mas comportamento downstream sim), BR-PRIVACY-005, view `v_meta_capi_health` (migration `0047`).

---

## ADR-040 — KV writes no edge worker são best-effort (2026-05-09)

### Status
aceito.

### Contexto
2026-05-09 ~11:00 UTC, pipeline tracker ficou DEAD. Symptom: ZERO `PageView`/`Lead`/`custom:click_*` no DB entre 10:42 e 16:58 UTC; forms continuavam (`lead_identify` chegava via `/v1/lead`) mas tracker silenciava em background. Root cause: Cloudflare KV daily quota free tier (1.000 writes/dia) atingiu o teto. Quando `kv.put()` falha por quota, lança `Error: KV put() limit exceeded for the day.`. `markSeen()` em [`apps/edge/src/lib/replay-protection.ts`](../../apps/edge/src/lib/replay-protection.ts) chamava `await kv.put(...)` cru — exception propagava pelo handler de [`apps/edge/src/routes/events.ts`](../../apps/edge/src/routes/events.ts) e virava 500. Tracker.js silencia 5xx (INV-TRACKER-007) então o cliente não percebia, só os events sumiam.

Outros KV writes do worker (rate-limit, config-cache, `idempotency.checkAndSet`, fx-rates cache) já tinham try/catch defensivo e degradavam graciosamente. `markSeen` era exceção — único call site que propagava.

### Decisão
**Todo `kv.put()` no edge worker é best-effort.** Falha de write NUNCA pode 500ar a request. Convenção:

1. Wrap em `try/catch`, retornar `boolean` (ou `Result<error>` se múltiplas modalidades de falha forem distinguíveis).
2. Caller loga `safeLog('warn', { event: '<nome>_kv_write_failed', request_id, workspace_id })`.
3. Não há retry inline — KV é storage não-crítico; quem deve persistir state crítico usa Postgres/Hyperdrive.

Aplica a:
- [`apps/edge/src/lib/replay-protection.ts`](../../apps/edge/src/lib/replay-protection.ts) `markSeen` — corrigido commit `85777ec`.
- [`apps/edge/src/lib/idempotency.ts`](../../apps/edge/src/lib/idempotency.ts) `checkAndSet` — já era best-effort.
- [`apps/edge/src/middleware/rate-limit.ts`](../../apps/edge/src/middleware/rate-limit.ts) — já era best-effort.
- [`apps/edge/src/routes/config.ts`](../../apps/edge/src/routes/config.ts) cache write — já era best-effort.
- [`apps/edge/src/integrations/fx-rates/cache.ts`](../../apps/edge/src/integrations/fx-rates/cache.ts) — já era best-effort.
- Qualquer novo `kv.put()` futuro.

**Defesa primária NÃO é KV.** Para replay-protection a defesa primária é o `unique (workspace_id, event_id, received_at)` constraint em `events` particionada + pre-insert `SELECT` (ver BR-EVENT-002 e padrão T-FUNIL-047/T-13-008). KV é só fast-path para evitar round-trip ao DB no caso comum. Para idempotency de webhook é a coluna `idempotency_key` em `raw_events`. Para rate-limit, perda transiente é aceitável (próxima request reposiciona o counter).

### Alternativas consideradas

- **Fail-closed (manter `throw`)** — defenderia replay-protection mais forte se KV está down, mas custa pipeline inteiro 500 em qualquer hiccup transiente do KV (não só quota — também regional outage, eventual consistency edge case). Custo > benefício porque defesa primária é DB constraint.
- **Retry inline com backoff** — gasta CPU time e write quota (paradoxalmente piora o problema de quota). KV não tem semântica idempotente de retry com TTL.
- **Migrar `markSeen` para Durable Objects** — fix arquitetural mais robusto (DO state é transactional + sem daily limit) mas é refator caro. Tech-debt registrado em `MEMORY.md §3` para depois.
- **Workers Paid plan** — feito em paralelo (2026-05-09 17:05 UTC). Resolve o ceiling, mas não substitui o try/catch — hiccups e quota mensal ainda existem.

### Consequências

- (+) Pipeline `/v1/events` sobrevive a esgotamento de KV quota / hiccups regionais — degrada apenas a defesa-em-profundidade do replay-protection.
- (+) Padrão consistente em todo edge worker — quem chega novo lê 1 ADR e replica.
- (+) Observabilidade preservada: warn log `replay_kv_write_failed` permite alerta proativo (ex.: regra de monitor "5+ warns em 1h" indica KV degradado).
- (–) Janela de replay-protection degradada: se KV está down e mesmo `event_id` é replayed em janela curta antes do DB rejeitar, pode haver gravação duplicada que só será detectada no `INSERT ... ON CONFLICT` (ainda detectada — só não no fast-path).
- (–) Padrão obriga disciplina: code review precisa rejeitar `await kv.put(...)` cru.

### Impacta
MOD-EVENT (replay-protection), MOD-DISPATCH (idempotency), MOD-WORKSPACE (config cache), BR-EVENT-004 (replay-protection — agora "best-effort defense-in-depth"), [`apps/edge/src/lib/replay-protection.ts`](../../apps/edge/src/lib/replay-protection.ts) (signature mudou: retorna `Promise<boolean>`).

---

## ADR-041 — `dispatch_attempts.{request,response}_payload_sanitized` carrega payload real (2026-05-09)

### Status
aceito.

### Contexto
2026-05-09, investigação do lead `75b3ed42` (Pedro): typo `.con` foi enviado pra Meta CAPI no primeiro Lead event, mas a `v_meta_capi_health` mostra `match_score=8` baseado no estado ATUAL do `lead.email_hash_external` — que foi sobrescrito pelo segundo submit corrigindo pra `.com`. **Sem visibilidade do payload realmente enviado, não há como auditar match quality histórico nem investigar regressão de EMQ ad-hoc.** As colunas `dispatch_attempts.request_payload_sanitized` e `response_payload_sanitized` (criadas nas migrations originais para esse propósito) gravavam `{}` literal em todos os 6 call sites de `apps/edge/src/lib/dispatch.ts` desde o início.

### Decisão
**Toda função `DispatchFn` anexa `request` (e idealmente `response`) ao `DispatchResult` retornado.** `processDispatchJob` aplica sanitização (redact `client_ip_address`/`ip`) e grava nos `dispatch_attempts`.

Convenção:
1. `DispatchResult` carrega `request?: unknown` e `response?: unknown` opcionais (`DispatchPayloadCapture` aplicado a todos variants).
2. Cada `buildXxxDispatchFn` em `apps/edge/src/index.ts` retorna `{ ok: true, request: payload, response: <body> }` no caminho de sucesso e `{ ...result, request: payload, response: <body> }` no caminho de falha.
3. `processDispatchJob` chama `sanitizeDispatchPayload` em [`apps/edge/src/lib/dispatch-payload-sanitize.ts`](../../apps/edge/src/lib/dispatch-payload-sanitize.ts) antes do INSERT — defesa em profundidade caso o dispatcher esqueça.
4. **PII redact obrigatório:** `client_ip_address`/`ip` em string não-vazia → `'[REDACTED]'`. Hashes (`em`/`ph`/`fn`/`ln`/`ct`/`st`/`zp`/`country`) preservados (já são SHA-256 — não-PII por design CAPI/Conversions). User-Agent preservado (não identifica unicamente per se; útil para auditoria de match quality).
5. Quando o dispatcher não anexar (rollout incremental), grava `{}` legacy.

### Alternativas consideradas

- **Salvar payload em claro (sem redact)** — simpler implementation, mas viola BR-PRIVACY-001 e LGPD Art. 46 (dados pessoais devem ser protegidos por medida técnica adequada). IP é PII pseudonimizada e duplicar exposição em outra coluna é mais surface area sem ganho real (debug não precisa de IP literal — basta saber se estava presente).
- **Enviar payload ao request_log de outra natureza** (ex.: KV ou bucket R2) — mais estado distribuído, complica erasure (LGPD direito ao esquecimento exige varrer toda fonte de dados pessoais). Coluna jsonb na mesma row de `dispatch_attempts` é alinhada com escopo de erasure.
- **Capturar via fetch interceptor / middleware no client HTTP** — quebra assertividade do "que foi enviado depois do mapper" (interceptor pega body raw, não a estrutura intermediária do dispatcher). Padrão escolhido (anexar no `DispatchResult`) pega a estrutura JS antes da serialização.
- **Truncar payloads grandes** — cogitado mas não necessário no MVP: payloads CAPI/GA4/Google Ads são <5KB, KB único de overhead por attempt. Reavaliar se aparecerem dispatchers com payloads grandes (ex.: bulk customer match com 10k+ records).

### Consequências

- (+) Auditoria real do que saiu pra Meta/Google/GA4 — match score regressions investigáveis.
- (+) Captura de error envelopes (Meta 4xx) habilita análise de causa-raiz sem precisar de tail real-time.
- (+) Padrão consistente entre dispatchers — onboarding novo dev lê 1 ADR + 1 BR e replica.
- (+) Defesa em profundidade: mesmo dispatcher esquecendo de redactar, sanitize layer captura.
- (–) +1KB de storage médio por attempt (ainda dentro de margem de Postgres jsonb).
- (–) Adoção incremental: atualmente só Meta CAPI tem response capture completa; GA4/Google Ads têm só request. Tabela de status em BR-DISPATCH-007.
- (–) Padrão obriga disciplina: code review precisa rejeitar `return { ok: true }` sem `request`.

### Impacta
MOD-DISPATCH (orchestrator), BR-DISPATCH-007 (nova), [`apps/edge/src/lib/dispatch.ts`](../../apps/edge/src/lib/dispatch.ts) (`DispatchResult` shape mudou — variants ganham `request?`/`response?`), [`apps/edge/src/lib/dispatch-payload-sanitize.ts`](../../apps/edge/src/lib/dispatch-payload-sanitize.ts) (novo helper), [`apps/edge/src/dispatchers/meta-capi/client.ts`](../../apps/edge/src/dispatchers/meta-capi/client.ts) (`MetaCapiResult` ganha `responseBody?` em failure variants), [`apps/edge/src/index.ts`](../../apps/edge/src/index.ts) (4 dispatchers tocados: meta_capi, ga4_mp, google_ads_conversion, google_ads_enhanced).

---

## ADR-042 — Outbox poller + native DLQ para `raw_events` presos em pending (2026-05-09)

### Status
aceito. Deploy `9b78719c` em 2026-05-09.

### Contexto
2026-05-09, investigação do lead Isaías (`f2912fd8`): só `lead_identify` e `Purchase` apareciam na timeline; faltavam `PageView`, `custom:click_buy_workshop` e `Lead`. Investigação encontrou **259 raw_events presos em `processing_status='pending'`** entre 10:00–17:00 UTC do mesmo dia, todos com payload válido. O corte coincidiu com o upgrade Workers Free → Paid às 17:05 UTC: o limite diário de requests do plano free saturou, queue consumer parou de drenar, mensagens enfileiradas exauriram retries (3× default Cloudflare) e foram **silenciosamente descartadas**, deixando os `raw_events` em `pending` indefinidamente.

Duas brechas de design no fluxo `events.ts → QUEUE_EVENTS → processRawEvent`:
1. Se `QUEUE_EVENTS.send()` lança no catch (queue indisponível, throttle), o `raw_events` já foi inserido como `pending` mas a mensagem **nunca entra na fila** — não há retry possível.
2. Se `processRawEvent` exauri retries do consumer, o Cloudflare descarta a mensagem sem callback ao worker — `raw_events` fica `pending` para sempre, sem `processing_error`.

### Decisão
**Adotar padrão Transactional Outbox com poller + DLQ nativa.**

1. **Cron `*/10 * * * *`** em `scheduledHandler` (`apps/edge/src/index.ts`) varre `raw_events` com `processing_status='pending'` na janela `[10min, 24h]` e re-enfileira via `QUEUE_EVENTS.send()`. Cobre tanto o caso (1) quanto recuperação de mensagens descartadas em (2). Limite superior de 24h evita loop infinito para eventos com payload patológico — emite warning `stuck_pending_events` para investigação manual.
2. **DLQ nativa** `gt-events-dlq` (criada via `wrangler@4 queues create`), declarada em `wrangler.toml` no consumer de `gt-events` (`max_retries=3, dead_letter_queue="gt-events-dlq"`). Após 3 retries, mensagem migra automaticamente para a DLQ.
3. **Consumer dedicado da DLQ** no `queueHandler` (rota por `batch.queue === 'gt-events-dlq'`) marca o `raw_events` como `processing_status='failed'` com `processing_error='dlq: max_retries exhausted on gt-events (attempts=N)'`. O cron poller deixa de re-enfileirar (filtro só pega `pending`), evitando loop.
4. **Logging melhorado** — `queue_events_enqueue_failed` agora inclui `raw_event_id` + `event_name`. Eventos `outbox_poll_completed`, `dlq_event_marked_failed`, `stuck_pending_events` para monitoramento via `wrangler tail`.

### Alternativas consideradas

- **Retry inline no `events.ts`** (re-tentar `QUEUE_EVENTS.send` com backoff antes de retornar 202) — aumenta latência da rota de ingestão e ainda não cobre caso (2) (queue retries esgotados).
- **Polling apenas, sem DLQ** — o plano inicial. Funciona, mas eventos patológicos ficam num loop "re-enqueue → fail → re-enqueue" até atingir 24h, gerando ruído de retry e custos de invocação. DLQ corta o loop em 3 tentativas.
- **DLQ apenas, sem poller** — não cobre caso (1) (mensagem nunca entrou na fila). Polling do outbox é necessário como rede de segurança independente.
- **Adicionar coluna `processing_attempts`** ao `raw_events` (soft DLQ) — exige migration. Cobre o caso de eventos patológicos, mas é estritamente inferior à DLQ nativa (que delegou contagem de tentativas e descarte ao Cloudflare). DLQ nativa estava bloqueada por wrangler 3+/4+ falhar com erro 10023, mas em 2026-05-09 o bug foi resolvido pela Cloudflare e wrangler@4 destravou.

### Consequências

- (+) Eventos transitoriamente perdidos (queue throttle, deploy gap, consumer crash) recuperam-se automaticamente em ≤10 minutos.
- (+) Eventos com payload patológico falham rápido (3 retries) e ficam visíveis em `processing_status='failed'` com motivo, em vez de invisíveis em `pending`.
- (+) Padrão Transactional Outbox alinhado com a literatura — `raw_events` já era o outbox; faltava o poller. Não exigiu novo storage.
- (+) `wrangler@4` destravou — `pnpm deploy:edge` simplificado, suporte a versioned deployments, DLQ nativa, e atualizações futuras desbloqueadas.
- (–) Cron roda a cada 10min mesmo sem eventos pendentes (custo desprezível: 1 query indexada).
- (–) Window mínima de 10min para recuperar — eventos perdidos dentro dessa janela ficam invisíveis ao usuário até o próximo tick. Aceitável para um sistema async.
- (–) Janela máxima de 24h: eventos perdidos por >24h precisam de replay manual (ler `stuck_pending_events` warning e re-enfileirar via script). OK no MVP — incidente assim deve disparar investigação humana de qualquer forma.

### Impacta
[`apps/edge/src/index.ts`](../../apps/edge/src/index.ts) (`scheduledHandler` ganha branch `*/10 * * * *`; `queueHandler` ganha branch `gt-events-dlq`), [`apps/edge/src/routes/events.ts`](../../apps/edge/src/routes/events.ts) (log `queue_events_enqueue_failed` adiciona `raw_event_id`+`event_name`), [`apps/edge/wrangler.toml`](../../apps/edge/wrangler.toml) ([triggers] crons + DLQ config), [`package.json`](../../package.json) (script `deploy:edge`). Comportamento de MOD-EVENT (recuperação automática) e observabilidade do pipeline raw_events → events.

---

## Política de promoção de OQ → ADR

OQ vira ADR somente se:
1. Decisão tomada com base técnica + input do stakeholder relevante.
2. Alternativas consideradas registradas.
3. Consequências (positivas e negativas) listadas.
4. Impacto em MOD-/CONTRACT-*/BR-* mapeado.
