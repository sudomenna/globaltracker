# MOD-ATTRIBUTION — Links, link_clicks, lead_attribution, redirector

## 1. Identidade

- **ID:** MOD-ATTRIBUTION
- **Tipo:** Core
- **Dono conceitual:** MARKETER (semântica de campanha) + DOMAIN (regras first/last-touch)

## 2. Escopo

### Dentro
- `links` (slug, destino, atribuição estrutural por anúncio).
- `/r/:slug` redirector.
- `link_clicks` (log de cada clique).
- `lead_attribution` (first-touch e last-touch por `(lead_id, launch_id)` — ADR-015).
- Cálculo determinístico de first/last-touch a partir de attribution params do payload `/v1/lead`.

### Fora
- Multi-touch e all-touch agregação avançada (Fase 3 entrega base; agregação fica para futuro).
- Análise estatística de incrementalidade (fora de escopo total).

## 3. Entidades

### Link
- `id`, `workspace_id`, `launch_id`
- `slug` (único global no domínio do redirector)
- `destination_url`
- `channel`, `campaign`
- `ad_account_id`, `campaign_id`, `adset_id`, `ad_id`, `creative_id`, `placement`
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`
- `status` (`active` / `archived`)
- `created_at`

### LinkClick
- `id`, `workspace_id`, `launch_id`
- `link_id` (FK opcional — clique pode ser direto via UTM sem link curto)
- `slug`
- `ts`
- `ip_hash`, `ua_hash`, `referrer_domain`
- `fbclid`, `gclid`, `gbraid`, `wbraid`, `fbc`, `fbp`
- `attribution` (jsonb consolidado)

### LeadAttribution
- `id`, `workspace_id`, `launch_id`
- `lead_id` (FK)
- `touch_type` (`first` / `last` / `all`)
- `source`, `medium`, `campaign`, `content`, `term`
- `link_id` (FK opcional)
- `ad_account_id`, `campaign_id`, `adset_id`, `ad_id`, `creative_id`
- `fbclid`, `gclid`, `gbraid`, `wbraid`, `fbc`, `fbp`
- `ts`

## 4. Relações

- `Link 1—N LinkClick`
- `Link 1—N LeadAttribution` (FK opcional — atribuição pode existir sem link curto)
- `Lead 1—N LeadAttribution`
- `Launch 1—N {Link, LinkClick, LeadAttribution}`

## 5. Estados

Sem state machine — `lead_attribution.touch_type` é discriminator:
- `first` — único por `(lead_id, launch_id)`.
- `last` — único por `(lead_id, launch_id)`; atualizado em cada nova conversão.
- `all` — múltiplos registros possíveis (preserva histórico).

## 6. Transições válidas

- First-touch: criado uma única vez quando lead é cadastrado em um launch.
- Last-touch: criado/atualizado a cada `Lead`/`Purchase` event.
- All-touch: insert append-only para cada touch identificado.

## 7. Invariantes

- **INV-ATTRIBUTION-001 — `(workspace_id, launch_id, lead_id, touch_type)` é único quando `touch_type IN ('first', 'last')`.** Constraint parcial. Testável.
- **INV-ATTRIBUTION-002 — `links.slug` é único globalmente.** `unique`. Testável.
- **INV-ATTRIBUTION-003 — Redirector registra `link_clicks` async sem bloquear redirect.** Testável: latência do `/r/:slug` < 50ms p95 mesmo com queue lenta.
- **INV-ATTRIBUTION-004 — `link_clicks.ip_hash` e `ua_hash` são SHA-256, não claros.** Testável.
- **INV-ATTRIBUTION-005 — First-touch vem do **primeiro** evento conhecido do lead em um launch; last-touch vem do **último** evento de conversão.** Definição executável: ordenação por `event_time` (com clamp aplicado). Testável.
- **INV-ATTRIBUTION-006 — Lead que reaparece em outro launch recebe novo first-touch para esse launch.** ADR-015. Testável.

## 8. BRs relacionadas

- `BR-ATTRIBUTION-*` — em `50-business-rules/BR-ATTRIBUTION.md`.

## 9. Contratos consumidos

- `MOD-IDENTITY.resolveLeadByAliases()` (lead_id resolvido).
- `MOD-LAUNCH.requireActiveLaunch()` (validação).
- `MOD-EVENT` (eventos como fonte de attribution params).

## 10. Contratos expostos

- `recordTouches({lead_id, launch_id, attribution, event_time}, ctx): Result<{first_created: boolean, last_updated: boolean}>`
- `getLinkBySlug(slug, ctx): Result<Link, NotFound | Archived>`
- `recordLinkClick(link, request_context, ctx): Promise<void>` (fire-and-forget; não bloqueia redirect)
- `getLeadAttribution(lead_id, launch_id, touch_type): Promise<LeadAttribution | null>`

## 11. Eventos de timeline emitidos

- `TE-LINK-CLICKED`
- `TE-FIRST-TOUCH-RECORDED`
- `TE-LAST-TOUCH-UPDATED`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/link.ts`
- `packages/db/src/schema/link_click.ts`
- `packages/db/src/schema/lead_attribution.ts`
- `apps/edge/src/lib/attribution.ts`
- `apps/edge/src/routes/redirect.ts`
- `tests/unit/attribution/**`
- `tests/integration/attribution/**`

**Lê:**
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/launch.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-IDENTITY`, `MOD-LAUNCH`, `MOD-WORKSPACE`.
**Proibidas:** `MOD-DISPATCH`, `MOD-AUDIENCE`.

## 14. Test harness

- `tests/unit/attribution/first-touch-once-per-launch.test.ts` — INV-ATTRIBUTION-006.
- `tests/unit/attribution/last-touch-updates.test.ts` — INV-ATTRIBUTION-005.
- `tests/integration/attribution/redirect-async-log.test.ts` — INV-ATTRIBUTION-003.
- `tests/integration/attribution/click-id-propagation.test.ts` — fbclid/gclid/etc capturados em link_clicks.
