# Sprint 17 — Lead Detail Observability (Header + Tabs + Event Cards)

> **Inserido em 2026-05-09**: redesenho da tela `/contatos/[lead_public_id]` no Control Plane após sessão de revisão real do lead Daniela Avila. A tela atual funciona como log técnico cronológico (27+ nós irmãos visualmente idênticos), inviabilizando que marketer/operator/admin entenda rapidamente a jornada do lead, audite despachos ou veja tags/consent/merges. Esta sprint reorganiza a página em 3 camadas: **header** com estado agregado (jornada, tags, atribuição, consent, métricas), **tabs** (Jornada/Eventos/Despachos/Atribuição/Consent/Identidade) e **EventCards** hierárquicos (evento pai → dispatches filhos com UTM inline e proveniência de tag).

## Duração estimada
3-5 sessões de trabalho (~7 ondas, 25 T-IDs).

## Objetivo
Transformar a tela de detalhe de contato de um log cronológico denso para uma tela de observabilidade narrativa, expondo todos os dados que o banco já tem mas a UI atual ignora (~60% do payload).

| Antes | Depois |
|---|---|
| 27 linhas idênticas "Despachado com sucesso" | EventCards hierárquicos (evento pai com 2 dispatches filhos) |
| Sem visão do estado atual (stage/tags/atribuição) | Header com 5 widgets agregados |
| `event_name` enterrado dentro de "Ver payload" | Nome do evento + origem como badge no card |
| Tags ausentes da timeline | Chips no header + nó inline na timeline |
| Consent/merges com TODO no código | Nós de timeline ativos + aba dedicada |
| Sem noção de UTM/atribuição por evento | UTM footer em cada EventCard + aba Atribuição |
| Despachos misturados com eventos | Aba Despachos técnica para operator |

## Pré-requisitos
- Sprint 16 completo (Ondas 1-12, ADR-032 a ADR-034).
- `lead_tags` populado por tag_rules (Sprint 16 Onda 10).
- `lead_consents`, `lead_merges` no schema (Sprints 1+5).
- API `/v1/leads/:publicId/timeline` em produção (`83afe16c`).

## Critério de aceite global

- [ ] Header com 5 widgets (Jornada, Tags, Atribuição, Consent, Métricas) renderizando para Daniela Avila.
- [ ] Tabs funcionais (Jornada/Eventos/Despachos/Atribuição/Consent/Identidade) com deep-link via `?tab=`.
- [ ] EventCards na aba Jornada agrupando dispatches sob seu evento pai.
- [ ] StageDivider entre eventos quando há mudança de stage.
- [ ] TagBadge inline ao lado do dispatch que originou a tag (correlação via `lead_tags.set_by="event:<event_name>"`).
- [ ] UTM footer em cada EventCard com `attribution_snapshot` não-vazio.
- [ ] Origem como Badge colorido (`tracker.js`/`webhook:guru`/`webhook:sendflow`/etc).
- [ ] Valor monetário formatado em BRL quando `custom_data.value` existir.
- [ ] PII masking respeitado por role em todas as abas.
- [ ] Aba Identidade restrita a operator/admin (marketer 403).
- [ ] Re-dispatch dialog acionável da aba Despachos e do EventCard.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verde.
- [ ] Smoke E2E na Daniela Avila com checklist da seção "Verificação E2E" verde.
- [ ] Edge deploy em prod com novos campos de timeline + endpoint summary.
- [ ] ADR sobre enriquecimento de payload da timeline registrado.
- [ ] `MEMORY.md §1` atualizado com commit hash + deploy edge ID.
- [ ] Docs canônicas sincronizadas (30-contracts/05 + 70-ux/06).

## T-IDs por onda

### Onda 1 — Backend: enriquecer leads-timeline.ts (parallel-safe=no — base de tudo)

- **T-17-001** [`edge-author`] Enriquecer `buildEventNode` em `apps/edge/src/routes/leads-timeline.ts`:
  - Adicionar ao payload: `event_source`, `custom_data` (filtrado para `value`/`currency`/`product_name`/`order_id`), `page_name` (LEFT JOIN `pages.title` via `events.page_id`), `launch_name` (LEFT JOIN `launches.name` via `events.launch_id`), `processing_status`, `attribution_snapshot` (subset de `events.attribution`: utm_*, fbclid, gclid).
  - Manter compatibilidade — só adições.
- **T-17-002** [`edge-author`] Enriquecer `buildDispatchNode`:
  - Adicionar `destination_resource_id`, `attempt_count` (subquery agregada de `dispatch_attempts`), `next_attempt_at`, `request_payload` (sanitizado, gated por role operator/admin), `replayed_from_dispatch_job_id`.
- **T-17-003** [`edge-author`] Enriquecer `buildAttributionNode` + `buildStageNode`:
  - Attribution: `utm_content`, `utm_term`, `touch_type`, `fbclid`, `gclid`, `ad_id`, `campaign_id`, `link_id`.
  - Stage: `from_stage`, `funnel_role`, `source_event_id`, `launch_id`, `is_recurring`.
- **T-17-004** [`edge-author`] Adicionar 3 novos node types:
  - `tag_added` (query nova em `lead_tags`, parse `set_by` para extrair `source_event_id` quando formato `event:<event_name>`).
  - Ativar `consent_updated` (descomentar TODO existente; payload `purposes_diff`+`source`+`policy_version`).
  - Ativar `merge` (query em `lead_merges`; payload `primary_lead`+`merged_lead`+`reason`+`before_summary`+`after_summary`+`performed_by`).
- **T-17-005** [`edge-author`] Atualizar enum `NodeType` no response Zod schema + documentação inline. Garantir ORDER BY `occurred_at DESC` consistente entre todos os node types ao fazer merge na timeline.

### Onda 2 — Backend: endpoint summary (parallel-safe=no — após Onda 1)

- **T-17-006** [`edge-author`] Criar `apps/edge/src/lib/lead-summary.ts` com `buildLeadSummary(leadId, workspaceId, role)`:
  - `current_stage`, `stages_journey` (todos stages cronologicamente).
  - `tags` (snapshot atual de `lead_tags` com `set_by`+`set_at`).
  - `attribution_summary` (first_touch + last_touch agregados de `lead_attribution`).
  - `consent_current` (último snapshot de `lead_consents` com 5 finalidades).
  - `metrics` (events_total, dispatches_ok/failed/skipped agregados de `dispatch_jobs`, purchase_total_brl somando `custom_data.value` de Purchase events, last_activity_at).
- **T-17-007** [`edge-author`] Criar rota `GET /v1/leads/:publicId/summary` em `apps/edge/src/routes/leads-summary.ts`:
  - Auth via `requireLeadReadAccess` (mesmo helper de leads-timeline).
  - PII masking por role.
  - Cache headers `Cache-Control: private, max-age=15`.
- **T-17-008** [`edge-author`] Zod schema do response em `apps/edge/src/schemas/lead-summary.ts` + montar rota em `apps/edge/src/index.ts` (mounting order: específico antes de genérico).

### Onda 3 — Frontend: header + tabs scaffold (parallel-safe=yes com 4+5)

- **T-17-009** [`general-purpose`] Modificar `apps/control-plane/src/app/(app)/contatos/[lead_public_id]/page.tsx`:
  - Server-side fetch de `/v1/leads/:id/summary` (em paralelo ao `/v1/leads/:id`).
  - Envolver conteúdo em `<Tabs defaultValue={searchParams.tab ?? 'jornada'}>`.
  - Tabs: `jornada` (default) | `eventos` | `despachos` | `atribuicao` | `consent` | `identidade` (esta última condicional a `role !== 'marketer'`).
- **T-17-010** [`general-purpose`] Criar `lead-summary-header.tsx` (server component):
  - 5 sub-componentes: `<JourneyStrip>` (chips de stages com timestamps), `<TagsPanel>` (chips), `<AttributionPanel>` (origem + UTM + click_ids), `<ConsentPanel>` (5 finalidades + atualizado em), `<MetricsPanel>` (4 mini-cards: eventos / dispatches OK-failed / valor comprado / última atividade).
  - Layout responsivo: 2 colunas em desktop, stack em mobile.
- **T-17-011** [`general-purpose`] Atualizar `?tab=` deep-link sync no client (manter compatibilidade com `?types=...&status=...&period=...` da timeline atual). Helper `useTabSync()` reutilizável.

### Onda 4 — Frontend: journey-tab + event-card (parallel-safe=yes com 3+5)

- **T-17-012** [`general-purpose`] Criar `journey-tab.tsx`:
  - Reusa fetch da timeline (`useTimeline()` hook extraído da Onda 5).
  - Agrupa nodes em "blocos de evento": cada `event_captured` vira um `<EventCard>` que carrega seus `dispatch_*` filhos (correlação via `dispatch.payload.event_id === event.payload.event_id` ou heurística temporal de janela 30s).
  - Intercala `<StageDivider>` quando aparece um `stage_changed` entre eventos.
  - Inline `<TagBadge>` ao lado do EventCard quando há `tag_added` correlacionado por `set_by="event:<event_name>"`.
- **T-17-013** [`general-purpose`] Criar `event-card.tsx`:
  - Header: nome do evento + badge de origem (cor por `event_source`) + valor monetário (BRL) + page_name + timestamp.
  - Body collapsado: lista compacta de dispatches (ícone + destination + status + duração).
  - Body expandido: payload formatado (`<pre>`), attribution snapshot, custom_data, processing_status.
  - Footer condicional: linha de UTM compacta `📍 utm_source=meta · utm_campaign=cs-junho-26` (só renderiza se `attribution_snapshot` não-vazio). Click_ids como pills.
  - A11y: `<article aria-labelledby="event-{id}">`.
- **T-17-014** [`general-purpose`] Componentes auxiliares: `<StageDivider>` (`role="separator"`), `<OriginBadge>` (cores tracker/webhook:*), `<MoneyValue>` (Intl.NumberFormat BRL), `<TagBadge>` (pill verde com `+#tag_name`).

### Onda 5 — Frontend: 4 abas técnicas + refatorar events-tab (parallel-safe=yes com 3+4)

- **T-17-015** [`general-purpose`] Refatorar `lead-timeline-client.tsx` → `events-tab.tsx`:
  - Mantém comportamento atual (filtros, paginação, "Ver payload").
  - Extrai fetch+filters em hook `useTimeline()` reusável por journey-tab.
  - Atualiza imports em `page.tsx`.
- **T-17-016** [`general-purpose`] Criar `dispatches-tab.tsx`:
  - Tabela técnica: colunas `event_name`, `destination`, `status`, `attempt_count`, `response_code`, `dispatch_request_id`, `occurred_at`, ações (re-dispatch, ver payload).
  - Filtros: destination (multi-select), status, período.
  - Reusa `RedispatchDialog` e `WhyFailedSheet`.
- **T-17-017** [`general-purpose`] Criar `attribution-tab.tsx`:
  - Seção "Touchpoints": tabela com first_touch + last_touch + intermediários se houver.
  - Colunas: `touch_type`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid`/`gclid`, `ad_id`/`campaign_id`, `link_id`, `occurred_at`.
- **T-17-018** [`general-purpose`] Criar `consent-tab.tsx`:
  - Estado atual no topo (5 toggles read-only com badge ON/OFF).
  - Histórico abaixo: tabela de `lead_consents` com `occurred_at`, `source` (tracker/webhook/admin), `policy_version`, `purposes_diff`.
- **T-17-019** [`general-purpose`] Criar `identity-tab.tsx` (operator/admin only):
  - Seção "Hashes externos" (email_hash_external, phone_hash_external, fn_hash, ln_hash).
  - Seção "Cookies/Identificadores" (fbp, fbc, _ga, client_id_ga4, session_id_ga4).
  - Seção "Geo + Device" (geo_city, geo_region_code, geo_country, ua_hash, referrer).
  - Marketer recebe redirect para aba Jornada se tentar acessar via deep-link.

### Onda 6 — Tests (parallel-safe=yes com 7)

- **T-17-020** [`test-author`] Integration tests backend:
  - `tests/integration/edge/leads-timeline-enriched.test.ts` — verifica novos campos em todos os node types + JOINs page_name/launch_name + 3 novos node types (tag/consent/merge).
  - `tests/integration/edge/leads-summary.test.ts` — verifica response shape + agregações + masking por role.
- **T-17-021** [`test-author`] Unit tests frontend:
  - `tests/unit/control-plane/event-card.test.tsx` — render com/sem custom_data/attribution_snapshot, expand/collapse, money format, origin badge cores.
  - `tests/unit/control-plane/lead-summary-header.test.tsx` — render de cada panel com fixtures.
  - `tests/unit/control-plane/journey-tab.test.tsx` — agrupamento evento→dispatches, StageDivider entre eventos.
- **T-17-022** [`test-author`] Smoke E2E manual checklist (Daniela Avila):
  - Validar todos os itens da seção "Verificação E2E" abaixo.
  - Documentar prints em `docs/00-product/` (opcional).

### Onda 7 — Doc-sync (parallel-safe=no — após 1-6)

- **T-17-023** [`docs-sync`] Atualizar `docs/30-contracts/05-api-server-actions.md`:
  - Documentar campos novos do response `/v1/leads/:id/timeline` (event_source, custom_data, page_name, launch_name, attribution_snapshot, attempt_count, etc).
  - Adicionar novo endpoint `GET /v1/leads/:id/summary` com schema completo.
- **T-17-024** [`docs-sync`] Atualizar `docs/70-ux/06-screen-lead-timeline.md`:
  - Substituir spec antiga por nova arquitetura: header agregado + tabs + EventCards.
  - Wireframe ASCII de cada tab.
  - Decisões de PII masking por role.
- **T-17-025** [`docs-sync`] Criar ADR em `docs/90-meta/04-decision-log.md`:
  - **ADR-035** "Enriquecimento de payload da timeline + endpoint summary dedicado".
  - Justificativa: tela atual exibia <40% do payload disponível; UI desperdiçava JOINs; não havia agregação para header.
  - Atualizar `MEMORY.md §1` com Sprint 17 entregue + commit hash + deploy edge ID.

## Verificação E2E

Caso de teste: lead **Daniela Avila** (`/contatos/4c9e6e3b-0bec-4b6c-a004-bc8da18aa7b0`).

### Header
- [ ] Jornada strip: `lead → purchased_workshop` com timestamps.
- [ ] Tags chips: `comprou_workshop`, `vip_main` (ou outras presentes em `lead_tags`).
- [ ] Atribuição: origem (Meta Ads ou similar) + UTM source/medium/campaign + fbclid se houver.
- [ ] Consent: 5 toggles ON com timestamp de última atualização.
- [ ] Métricas: 11 eventos / 14 dispatches OK / R$ 297,00 / última atividade 21:13.

### Aba Jornada (default)
- [ ] EventCard `Purchase · R$ 297,00 · webhook:guru` com Meta CAPI + GA4 MP filhos colapsados.
- [ ] StageDivider visível entre `lead` e `purchased_workshop`.
- [ ] EventCard `custom:wpp_joined · webhook:sendflow` com TagBadge `+#vip_main` inline.
- [ ] UTM footer no EventCard `Lead` inicial (se attribution_snapshot não-vazio).

### Aba Eventos
- [ ] Filtros tipo/status/período funcionando como antes.
- [ ] "Ver payload" expansível.

### Aba Despachos
- [ ] 14 linhas (matching com métricas do header).
- [ ] Filtro por destination (Meta CAPI / GA4 MP).
- [ ] Botão re-dispatch acionável (só operator/admin).

### Aba Atribuição
- [ ] First touch + Last touch separados.
- [ ] UTM completo (source/medium/campaign/content/term).
- [ ] Click IDs (fbclid/gclid) se houver.

### Aba Consent
- [ ] Estado atual (5 toggles).
- [ ] Histórico se houver mudança em `lead_consents`.

### Aba Identidade
- [ ] Marketer redirecionado para aba Jornada (acesso negado).
- [ ] Operator/admin vê hashes externos + cookies + geo/device.

### Regressões
- [ ] PII masking respeita role em todas as abas.
- [ ] URL `?tab=despachos&types=dispatch_failed` deep-linka corretamente.
- [ ] RedispatchDialog continua funcionando.
- [ ] WhyFailedSheet continua funcionando.

## Referências

- [`docs/70-ux/06-screen-lead-timeline.md`](../70-ux/06-screen-lead-timeline.md) — spec original (será reescrita na T-17-024)
- [`docs/30-contracts/05-api-server-actions.md`](../30-contracts/05-api-server-actions.md) — contrato API
- [`docs/50-business-rules/BR-PRIVACY.md`](../50-business-rules/BR-PRIVACY.md) — regras de PII masking
- [`docs/50-business-rules/BR-RBAC.md`](../50-business-rules/BR-RBAC.md) — restrição por role
- [`docs/90-meta/04-decision-log.md`](../90-meta/04-decision-log.md) — ADR a registrar (T-17-025)

## Fora de escopo (futuras iterações)

- Visão "sessões" (agrupar eventos por `sessionStorage` do tracker) — requer índice/coluna `session_id` em `events`.
- Replay de eventos (não só dispatches) — fora do contrato atual.
- Edição manual de tags pelo operator — separado, vira ação dentro da aba Tags.
- Visualização horizontal da timeline (diagrama Gantt) — substancialmente mais trabalho.
- Comparação lado-a-lado de leads (Sprint 18+).
