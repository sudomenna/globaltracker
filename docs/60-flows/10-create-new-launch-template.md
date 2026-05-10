# Flow 10: Criar um novo template de lançamento

> **Quem usa este doc:** orquestrador (você) ao receber pedido tipo "queremos lançar um funil X (live evergreen / trial gratuito / summit / outro)" — ou qualquer demanda que crie um **novo template** em `funnel_templates`.

Este playbook codifica os padrões descobertos durante o lançamento `wkshop-cs-jun26`
(funil B v3 — `lancamento_pago_workshop_com_main_offer`) para que a próxima sessão consiga
criar um novo template canônico **sem reinventar decisões já tomadas**.

---

## 1. Pré-requisitos de informação

Antes de tocar em código, levantar com o usuário (ou inferir do brief):

- **Slug do template** (ex: `live_evergreen_oferta_unica`) — formato snake_case, prefixar com tipo de funil.
- **Estrutura do funil** — pages que compõem o funil, ordem do percurso do visitante.
- **Stages** — pontos de progressão mensuráveis no funil (ex: `clicked_buy`, `purchased`, `watched`, `wpp_joined`).
- **Audiences** — segmentos remarketing/lookalike a alimentar.
- **Custom events** — ações específicas além de PageView/Lead/Purchase (ex: `click_buy_*`, `wpp_join`, `watched_*`).
- **Integrações esperadas** — Meta CAPI? GA4? Google Ads? Hotmart/Guru/Stripe? SendFlow?

Se algo crítico estiver indefinido, parar e perguntar antes de codificar.

---

## 2. Atribuir `role` a cada page

Cada page do template tem um `role` que dita o snippet boilerplate e a flag `auto_page_view`:

| `role` | Quando usar | `auto_page_view` |
|---|---|---|
| `sales` | Page de captura de lead (form), page de oferta com CTA de checkout | `true` |
| `webinar` | Page de aula gravada/ao vivo, conteúdo consumido por lead já identificado | `true` |
| `thankyou` | Page pós-checkout (recebe URL params do gateway), pós-cadastro | `false` |

Regra (`docs/20-domain/13-mod-tracker.md` §7.5): `sales`/`webinar` = `true`, `thankyou` = `false`. Não inventar.

---

## 3. Definir `event_config` de cada page

Cada page tem 3 chaves no `event_config`:

```json
{
  "canonical": ["PageView", "Lead", "Purchase"],
  "custom": ["click_buy_x", "watched_x"],
  "auto_page_view": true
}
```

- **`canonical`** — eventos Meta-standard que essa page **pode** disparar (PageView, Lead, ViewContent, InitiateCheckout, Purchase, Contact, etc.). É um allowlist que o `/v1/events` valida.
- **`custom`** — custom events sem prefixo `custom:` (o tracker prefixa automaticamente). Ex: `click_buy_workshop` aqui = tracker dispara `custom:click_buy_workshop`.
- **`auto_page_view`** — derivado do `role` (ver §2).

---

## 4. Catalogar custom events e mappings

Para cada custom event que o template introduz, atualizar **5 lugares** (ver `docs/40-integrations/00-event-name-mapping.md` "Custom events"):

1. **Tracker (snippet de page)** — disparar via `Funil.track('custom:nome')`.
2. **Meta CAPI mapper** (`apps/edge/src/dispatchers/meta-capi/mapper.ts` `INTERNAL_TO_META_EVENT_NAME`) — mapear para Meta standard event mais próximo (ex: `'custom:click_buy_x': 'InitiateCheckout'`).
3. **GA4 mapper** (`apps/edge/src/dispatchers/ga4-mp/mapper.ts` `INTERNAL_TO_GA4_EVENT_NAME`) — mapear para GA4 recommended event (ex: `'custom:click_buy_x': 'begin_checkout'`).
4. **Snippet browser** — disparar `fbq('track', 'InitiateCheckout', {}, { eventID: window.__funil_event_id })` logo após `Funil.track()` para dedup.
5. **`event_config.custom` da page** — incluir `'click_buy_x'` (sem prefixo).

**Regra crítica de naming:** Pixel browser e CAPI devem usar o **mesmo nome** standard Meta para Meta deduplicar. Se o custom event não tem standard equivalente, usar `fbq('trackCustom', 'NomePersonalizado')` em ambos os lados, e adicionar mapping idêntico no Meta CAPI mapper.

---

## 5. Definir stages do template (`blueprint.stages`)

Cada stage representa um **ponto de progressão** mensurável no funil. Consumido pelo lead-stages-resolver para promover leads conforme eventos.

```json
{
  "slug": "clicked_buy_workshop",
  "label": "Clicou comprar workshop",
  "is_recurring": true,
  "source_events": ["custom:click_buy_workshop"]
}
```

- **`slug`** — snake_case, único no template, descreve o estado.
- **`label`** — texto pt-BR mostrado em dashboards.
- **`is_recurring`** — `true` quando o evento pode disparar várias vezes na vida do lead (ex: cliques de intent); `false` para estados terminais (ex: comprou, assistiu).
- **`source_events`** — array de `event_name` que ativam este stage. Pode incluir filtros: `"source_event_filters": {"funnel_role": "main_offer"}`.

Ordem dos stages no array reflete a ordem do funil (do topo para o fundo).

---

## 6. Definir audiences

```json
{
  "slug": "compradores_workshop_aquecimento",
  "name": "Compradores workshop — aquecimento",
  "platform": "meta",
  "query_template": {
    "stage_eq": "purchased_workshop",
    "stage_not": "purchased_main"
  }
}
```

- **`platform`** — `meta` ou `google` (depende da plataforma de remarketing).
- **`query_template`** — combinações suportadas: `stage_eq`, `stage_gte`, `stage_lte`, `stage_not`, `stage_in`. O audience-resolver materializa em queries do `lead_stages`.

---

## 7. Criar a migration

Padrão: incrementar o número da última migration em `packages/db/migrations/`. Estrutura:

```sql
-- Migration: 00XX_funnel_template_<slug>.sql
-- Cria template global (workspace_id IS NULL) com is_system=true.

INSERT INTO funnel_templates (slug, name, blueprint, workspace_id, is_system)
VALUES (
  'novo_slug',
  'Nome amigável',
  $json${
    "type": "...",
    "stages": [...],
    "pages": [
      {"role": "sales", "suggested_public_id": "...", "suggested_funnel_role": "...",
       "event_config": {"canonical": [...], "custom": [...], "auto_page_view": true}},
      {"role": "thankyou", ..., "event_config": {..., "auto_page_view": false}}
    ],
    "audiences": [...]
  }$json$::jsonb,
  NULL,
  true
)
ON CONFLICT (slug) WHERE workspace_id IS NULL DO UPDATE
  SET blueprint = EXCLUDED.blueprint, updated_at = now();
```

Sempre `auto_page_view` explícito por page no blueprint (referência: `0039_funnel_template_paid_workshop_v3_auto_page_view.sql`). Migration idempotente (UPDATE com forma alvo final, re-run = noop).

---

## 8. Criar snippets canônicos

Criar diretório `apps/tracker/snippets/<template-slug>/` e gerar um arquivo HTML por page. Cada arquivo é o snippet de **footer** que o operador vai colar no WPCode/equivalente.

Boilerplate por role (referência `apps/tracker/snippets/paid-workshop/`):

| Page role | Arquivo | Inclui |
|---|---|---|
| `sales` (capture) | `<page>.html` | `withTracker`, `fbqIfAvailable`, `fbqAutoPageView`, `wireBuyButton` (CTA → custom event + fbq), `wireForm` (POST /v1/lead com `attribution: readUtms()` + consent granted + identify + Lead + fbq; redirect **dentro** do `withTracker` callback com fallback de 2s — ver BR-TRACKER-002), `boot` |
| `sales` (oferta sem form) | `<page>.html` | `withTracker`, `fbqIfAvailable`, `bootIdentity` (rebind localStorage), `F.page` + `fbqIfAvailable` PageView, `wireBuyButton` (CTA → custom event + fbq) |
| `webinar` | `<page>.html` | `withTracker`, `fbqIfAvailable`, identity rebind, `F.page` + `fbqIfAvailable` PageView, listener de engagement event |
| `thankyou` | `<page>.html` | `withTracker`, `fbqIfAvailable`, `readParamsAndStrip`, `postLead` (consent granted) ou hot path `__gt_ftk`, `F.page` + `fbqIfAvailable` PageView, opcional listeners de engagement |

Snippet de **head** é o mesmo em todas as pages — referência em `docs/70-ux/13-tutorial-instalacao-tracking.md` §3-§5 (GA4 + Meta Pixel + tracker.js, nessa ordem).

---

## 9. Atualizar mappers (se introduziu custom events novos)

Se o §4 listou custom events novos, abrir e editar:

- `apps/edge/src/dispatchers/meta-capi/mapper.ts` — adicionar entries ao `INTERNAL_TO_META_EVENT_NAME`.
- `apps/edge/src/dispatchers/ga4-mp/mapper.ts` — adicionar entries ao `INTERNAL_TO_GA4_EVENT_NAME`.

Cada custom event sem mapping aqui vai cair no fallback do mapper:
- Meta CAPI: passa o nome interno cru (ex: `custom:click_buy_x`) — **não dedupa com Pixel** que usaria nome diferente.
- GA4: retorna `null` → dispatch_job skipped com `no_ga4_equivalent`.

---

## 10. Atualizar Edge `events.ts` — `allowed_event_names`

A rota `POST /v1/events` valida o `event_name` recebido contra `pages.event_config.allowed_event_names`. Esta lista é construída em runtime concatenando `canonical` + `custom.map(c => 'custom:' + c)`.

Garantir que custom events da §4 estejam em `event_config.custom` da page correspondente (§3) — senão o tracker envia eventos que o Edge rejeita silenciosamente.

---

## 11. Documentar

Antes de marcar o template como "pronto":

- Atualizar `docs/40-integrations/00-event-name-mapping.md` "Custom events catalogados" com os novos entries (mapping + stage typical).
- Atualizar `docs/80-roadmap/97-ownership-matrix.md` se houver novos arquivos de snippet (`apps/tracker/snippets/<slug>/`).
- Se o template introduz nova integração inbound (ex: novo gateway), criar doc em `docs/40-integrations/` seguindo padrão dos existentes.

---

## 12. Test plan

Antes de release:

1. **Migration**: aplicar em ambiente de staging, verificar `funnel_templates.blueprint` parsing (Zod schema em `apps/edge/src/lib/funnel-blueprint.ts`).
2. **Scaffolding de launch**: criar uma launch a partir do template via UI do CP — verificar que pages criadas têm `event_config.auto_page_view` populado conforme blueprint.
3. **Validação E2E manual** seguindo `docs/70-ux/13-tutorial-instalacao-tracking.md` §8 — uma capture + uma thankyou, validar:
   - PageView dispara em ambas (auto na capture, manual na thankyou).
   - Lead dispara via form submit, com `consent.ad_user_data='granted'`.
   - Custom events disparam e são dedupados (Pixel + CAPI).
   - GA4 events succeeded (não skipped por `no_ga4_equivalent`).
4. **Audiences materializam** — rodar audience-sync em dry-run, verificar contagens contra estado dos `lead_stages`.

---

## 13. Anti-padrões / armadilhas conhecidas

- ❌ **Não definir `auto_page_view` no blueprint** → page criada com flag ausente, tracker não dispara PageView (descoberto na sessão `wkshop-cs-jun26` em 2026-05-07; corrigido por migration `0039`).
- ❌ **Snippet POST `/v1/lead` com `consent: { analytics: false, ... }`** → backend interpreta como `denied`, dispatch é bloqueado. Sempre todas as 5 finalidades `'granted'`.
- ❌ **Custom event sem mapping no Meta CAPI mapper** → CAPI envia nome cru (`custom:X`), Pixel envia outro nome → não deduplica. Sempre mapear para Meta standard ou usar `trackCustom` com mesmo nome em ambos os lados.
- ❌ **Pixel snippet com `fbq('track', 'PageView')` no init** → duplica PageView do tracker. Remover essa linha do snippet do Pixel; PageView é disparado pelo `fbqAutoPageView` (sales/webinar) ou pelo `fbqIfAvailable` após `F.page()` (thankyou).
- ❌ **Esquecer de excluir `tracker.js`/`fbevents.js`/`gtag` do WP Rocket (ou cache plugin equivalente)** → scripts são minificados/atrasados, cookies não são setados a tempo, eventos chegam sem `_ga`/`_fbp`. Ver `docs/70-ux/13-tutorial-instalacao-tracking.md` §7.
- ❌ **Usar nome de query param `name`** em URL de redirect (Framer/Wordpress reservam) → 404 no destination. Usar `lead_name` na URL e mapear para `name` no body do POST.

---

## 14. Referências

- `docs/20-domain/13-mod-tracker.md` §7.5 — padrões de snippet por role
- `docs/40-integrations/00-event-name-mapping.md` — mappings completos
- `docs/70-ux/13-tutorial-instalacao-tracking.md` — tutorial de instalação no site
- `apps/tracker/snippets/paid-workshop/` — snippets canônicos de referência
- `packages/db/migrations/0034_funnel_template_paid_workshop_v3.sql` — referência de migration de template
- `packages/db/migrations/0039_funnel_template_paid_workshop_v3_auto_page_view.sql` — referência de propagação de `auto_page_view`
- `apps/edge/src/dispatchers/meta-capi/mapper.ts` — mapper Meta (custom events)
- `apps/edge/src/dispatchers/ga4-mp/mapper.ts` — mapper GA4 (custom events + group_id)
