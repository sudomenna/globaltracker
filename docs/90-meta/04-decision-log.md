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

## Política de promoção de OQ → ADR

OQ vira ADR somente se:
1. Decisão tomada com base técnica + input do stakeholder relevante.
2. Alternativas consideradas registradas.
3. Consequências (positivas e negativas) listadas.
4. Impacto em MOD-/CONTRACT-*/BR-* mapeado.
