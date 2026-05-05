# Sprint 13 — Funil B foundation: identidade BR + SendFlow inbound + cleanups S12

> **Nota**: Este sprint sofreu reposicionamento em 2026-05-05. Originalmente era o sprint dos adapters Hotmart/Kiwify/Stripe (agora Sprint 14). Foi refocado quando o E2E real do funil B (`wkshop-cs-jun26`) revelou que o pipeline de identidade precisa de fortalecimento BR-aware antes de plugar mais provedores. SendFlow é o provedor crítico imediato — destrava o stage `wpp_joined` (Contact server-side) já em produção.
>
> O filename ainda menciona "webhooks-hotmart-kiwify-stripe" por referência histórica; o conteúdo canônico é o atual.

## Duração estimada
A definir.

## Objetivo
Fortalecer a foundation de identidade do GlobalTracker pra suportar matching cross-system robusto (form do site, webhooks Guru/SendFlow, futuros adapters), e plugar o primeiro webhook de WhatsApp grupo (SendFlow → `Contact` → stage `wpp_joined`). Inclui também os cleanups herdados do Sprint 12 que ainda não foram fechados.

## Pré-requisitos
- Sprint 12 completo (template paid_workshop realinhado e funil B validado E2E em produção real).
- Sprint 11 completo (Funil Configurável Fase 3 — webhook Guru contextualizado já em produção).

## Critério de aceite global

- [ ] `normalizePhone` reconcilia mobiles BR com e sem o "9" extra (T-13-014).
- [ ] SendFlow webhook inbound em produção, disparando `Contact` para stage `wpp_joined` (T-13-011).
- [ ] Cleanups de identidade/dedup (T-13-008/-009/-010) aplicados.
- [ ] CP save handler de `event_config` corrigido (T-13-013).
- [ ] Survey form em `obrigado-workshop` disparando `custom:survey_responded` (T-13-012).
- [ ] Cleanups de testes herdados de S12 (T-13-005/-006) verdes.
- [ ] FLOW-09 (lead resolve cross-system com phone variantes) verde em integration tests.

## T-IDs

### Cleanups herdados do Sprint 12

Falhas pré-existentes detectadas durante a verificação consolidada do Sprint 12 (descobertas por T-FUNIL-039 e T-FUNIL-041), fora do escopo Sprint 12 e realocadas para este sprint:

- **T-13-005** — `tests/integration/routes/config.test.ts:443` — fallback "200 quando DB binding ausente" não retorna o esperado. Investigar `apps/edge/src/routes/config.ts` para o caminho `env.DB === undefined`.
- **T-13-006** — `tests/integration/routes/integrations-test.test.ts:235` — Zod `.strict()` não rejeita extra fields no `POST /v1/integrations/:provider/test`. Possível downgrade do schema em refactor recente — verificar com `git log -p apps/edge/src/routes/integrations-test.ts`.

> **Nota**: T-13-007 (Stripe signature tolerance off-by-one) foi migrado pra Sprint 14 por proximidade de domínio com o adapter Stripe (lá é T-14-005).

### Identidade & integrações inbound — foundational

- **T-13-008** — Replicar fix de pre-insert dedup do `guru-raw-events-processor.ts` em `apps/edge/src/lib/raw-events-processor.ts` (tracker). ✅ **CONCLUÍDO 2026-05-05** (deploy `f552f472`). SELECT prévio por `(workspace_id, event_id)` antes do INSERT em `apps/edge/src/lib/raw-events-processor.ts:557+`. Cobre retries do tracker.js (sessões com mesmo event_id mas received_at distintos) que passariam pelo unique constraint particionado.
- **T-13-009** — Investigar Guru `source.utm_*` chegando `null` mesmo quando checkout abriu com UTMs preservados. ⚠️ **INVESTIGAÇÃO PARCIAL 2026-05-05**: confirmado que TODOS os 4 webhooks Guru recebidos no DB têm `source.utm_*` null + `source.checkout_source` null + `source.pptc: []`. Bug é externo (provável config Guru não passando UTMs cross-domain ou conta operando sem rastreamento). Reprodução exige compra real com UTMs explícitas (`?utm_source=teste&utm_campaign=teste` no link de abertura do checkout). Aguardando Trilha A (Purchase real). Mantém status: `planejado` até reproduzir.
- **T-13-010** — Aplicar `update_if_newer` baseado em `dates.updated_at` no Guru webhook handler. ✅ **CONCLUÍDO 2026-05-05** (deploy `f552f472`). Achado adicional: o schema lia `payload.confirmed_at` mas Guru moderno aninha em `payload.dates.confirmed_at` — inconsistência também corrigida. Schema `GuruRawEventPayloadSchema` agora inclui `dates: { canceled_at, confirmed_at, created_at, expires_at, ordered_at, unavailable_until, updated_at, warranty_until }`. Pre-insert dedup compara `dates.updated_at` do existing vs novo: se novo é mais recente, faz `UPDATE events SET event_time, customData WHERE id`. Decision tree:
    - 1º chega com `confirmed_at:null` → INSERT com null
    - 2º chega com `confirmed_at:<valor>` e `updated_at` mais recente → UPDATE supera o null
    - 2º chega com `updated_at` mais antigo → skip (mantém valor melhor)
  `customData.dates` armazena o objeto inteiro pra futuras comparações. Logs `guru_webhook_updated_with_newer_payload` vs `guru_webhook_duplicate_skipped` distinguem os caminhos.
- **T-13-011** — SendFlow webhook inbound. ✅ **CONCLUÍDO 2026-05-05** (deploy `dbb24ea2`). Adapter em [`apps/edge/src/routes/webhooks/sendflow.ts`](../../apps/edge/src/routes/webhooks/sendflow.ts) + migration 0035 (`workspace_integrations.sendflow_sendtok`) + migration 0036 (template v3.1 com novo stage `wpp_joined_vip_main`) + mapping `workspaces.config.sendflow.campaign_map`. Suporta 2 campanhas no mesmo launch (decisão Tiago): grupo Compradores Workshop (campaign `3bhG8XexRRKwLxF4SGtk`) → `Contact` → stage `wpp_joined`; grupo VIP Main (campaign `0b4IxLZFiYOxxRyO6ZmE`) → `custom:wpp_joined_vip_main` → stage `wpp_joined_vip_main`. `members.removed` → `custom:wpp_left` (gravado, sem stage). Auth via header `sendtok` constant-time. Idempotency por `payload.id`. Validado E2E em produção: 4 raw_events de teste com cross-system phone matching (lead `44832364` casou com `5511988887777` SEM o 9, mesmo lead criado com 9 via form workshop).
- **T-13-016** (NOVO — UI debt). Tela no Control Panel para cadastrar `workspace_integrations.sendflow_sendtok` + `workspaces.config.sendflow.campaign_map` (entradas com {launch, stage, event_name}). Hoje setado por SQL direto (operacional só, não-autosserviço). Custo estimado ~1-2h. Não bloqueia operações; vira essencial quando outros workspaces precisarem cadastrar SendFlow sem dev no loop.
- **T-13-012** — Survey form na page `obrigado-workshop` disparando `custom:survey_responded` → stage `survey_responded`. Detalhe em `MEMORY.md` §8.
- **T-13-013** — Bug do save handler do CP que double-stringifica `event_config`/`workspaces.config` (grava string JSON dentro de JSONB em vez de objeto cru). ✅ **CONCLUÍDO 2026-05-05** (deploy `15fea1a0`). Causa-raiz: driver `pg-cloudflare-workers` (Hyperdrive) trata params do Drizzle como text-com-aspas literal — `$1::jsonb` e `($1)::jsonb` viravam jsonb-string. Solução: helper `apps/edge/src/lib/jsonb-cast.ts` (exporta `jsonb(value)`) que usa `sql.raw()` com dollar-quoted string `$gtjsonb$<json>$gtjsonb$::jsonb`, inline ao invés de parametrizado. Postgres faz cast correto. Aplicado em `routes/pages.ts` (PATCH event_config) e `routes/workspace-config.ts` (PATCH config). Pendência menor (T-13-013-FOLLOWUP): aplicar em call sites de `db.insert(rawEvents).values({payload})` — não bloqueia operação.
- **T-13-014** — Normalizador de telefone BR-aware (9-prefix). Upgrade de [`apps/edge/src/lib/lead-resolver.ts:67`](../../apps/edge/src/lib/lead-resolver.ts#L67) (`normalizePhone`) pra reconciliar mobiles BR com e sem o 9 extra (mandato Anatel de 2014; sistemas legados como SendFlow ainda enviam sem). Heurística determinística baseada na regra de numeração: landline BR nunca começa com 6/7/8/9. **Bloqueia T-13-011** (SendFlow envia phone sem o 9). Doc canônica: [`docs/50-business-rules/BR-IDENTITY.md`](../50-business-rules/BR-IDENTITY.md) BR-IDENTITY-002 + nova INV-IDENTITY-008.
- **T-13-015** — Wire `encryptPii` no pipeline de criação de lead. Bug crítico descoberto durante T-13-014: a função `encryptPii` em [`apps/edge/src/lib/pii.ts:157`](../../apps/edge/src/lib/pii.ts#L157) existe mas é órfã — nunca é chamada. Resultado: `leads.email_enc / phone_enc / name_enc` ficam todos NULL, quebrando admin export, DSAR (LGPD/GDPR), suporte ao cliente e qualquer backfill futuro. Helper novo em [`apps/edge/src/lib/pii-enrich.ts`](../../apps/edge/src/lib/pii-enrich.ts) é chamado após `resolveLeadByAliases` em `routes/lead.ts`. Soft-fail: se `PII_MASTER_KEY_V1` não está setado, lead é criado com hashes apenas (igual hoje, sem regressão); se está, ciphertexts populam. Aceitamos perda dos 13 leads sintéticos pré-T-13-015 (plaintext nunca foi gravado, irrecuperável). Próximas iterações vão estender pra Guru webhook (`guru-raw-events-processor.ts:375`) — fora desse T-ID.

## Referências de integração

- [`docs/30-contracts/04-webhook-contracts.md`](../30-contracts/04-webhook-contracts.md)
- [`docs/50-business-rules/BR-IDENTITY.md`](../50-business-rules/BR-IDENTITY.md)
- `~/.claude/projects/.../memory/reference_sendflow.md` (operacional, fora do repo)
