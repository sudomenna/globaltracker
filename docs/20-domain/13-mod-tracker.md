# MOD-TRACKER — Tracker.js (front-end)

## 1. Identidade

- **ID:** MOD-TRACKER
- **Tipo:** Core (cliente — bundle JS instalado em LPs)
- **Dono conceitual:** OPERATOR (deploy do bundle) + DOMAIN (lógica de captura/cookies/identify)

## 2. Escopo

### Dentro
- Bundle `tracker.js` (TypeScript vanilla, < 15 KB gzipped, sem dependências externas).
- Inicialização: lê data attrs (`data-site-token`, `data-launch-public-id`, `data-page-public-id`); busca `/v1/config`; captura UTMs/click IDs/cookies de plataforma.
- API pública: `Funil.track()`, `Funil.identify()`, `Funil.decorate()`, `Funil.page()`, `Funil.logout()`.
- Cookies próprios: `__fvid` (anônimo, Fase 3), `__ftk` (lead_token, Fase 2).
- Captura de cookies de plataforma: `_gcl_au`, `_ga`, `_fbc`, `_fbp` (ver §7.6 para o mapeamento de chaves canônicas).
- Pixel policy enforcement (`server_only` / `browser_and_server_managed` / `coexist_with_existing_pixel`).
- Gestão de attribution params em `localStorage` para replay em `/v1/lead`.

### Fora
- Renderização de UI (tracker.js não tem UI).
- Lógica de domínio (resolução de lead etc. é do Edge).
- Decisão de quais eventos disparar (vem do `event_config` da página).

## 3. Entidades (estado em runtime, não em DB)

### TrackerState (in-memory + cookies + localStorage)
- `siteToken` (data attr)
- `launchPublicId`, `pagePublicId` (data attrs)
- `config` (de `/v1/config`)
- `__fvid` (cookie)
- `__ftk` (cookie, lead_token)
- `attributionParams` (localStorage — utm_*, gclid, fbclid, etc.)
- `platformCookies` (in-memory após captura — `_gcl_au`, `_ga`, `fbc`, `fbp` — ver §7.6 para o mapeamento de chaves do browser)
- `consent` (in-memory após captura)

## 4. Relações (lógicas)

- Tracker → Edge `/v1/config` (init)
- Tracker → Edge `/v1/events` (cada evento)
- Tracker → Edge `/v1/lead` (form submit)

## 5. Estados (lógicos)

```
[loading] → [initialized] → [ready]
                         → [paused] (consent denied global)
```

## 6. Transições válidas

- `loading` → `initialized` quando `/v1/config` retorna 200.
- `initialized` → `ready` após captura inicial de cookies/UTMs.
- `ready` → `paused` se consent_analytics negado (não emite eventos).

## 7. Invariantes

- **INV-TRACKER-001 — Bundle final < 15 KB gzipped.** Verificado em build CI. Testável.
- **INV-TRACKER-002 — Tracker não depende de nenhuma lib externa em runtime.** `package.json` `dependencies` vazio (apenas devDependencies). Testável.
- **INV-TRACKER-003 — `__fvid` só é setado se `consent_analytics='granted'`.** Lógica em `cookies.ts` do tracker. Testável.
- **INV-TRACKER-004 — `__ftk` é lido (não criado pelo tracker) — emissor é o backend.** Testável.
- **INV-TRACKER-005 — Tracker nunca envia PII em claro a `/v1/events`.** Apenas `/v1/lead` aceita PII em claro (que o backend hasheia/encrypta). Validado por integration test. Testável.
- **INV-TRACKER-006 — Em política `browser_and_server_managed`, `eventID` do Pixel browser é igual ao `event_id` enviado a CAPI.** Coordenação client-side via `window.__funil_event_id`. Testável.
- **INV-TRACKER-007 — Falha no `/v1/config` não quebra a página — tracker degrada silenciosamente.** Testável: simular 500 do config e confirmar que página carrega normalmente.
- **INV-TRACKER-008 — `Funil.identify({lead_token})` aceita apenas token assinado válido — não aceita `lead_id` em claro a partir do browser.** ADR-006. Testável.

### Mecanismo de deduplicação de eventos (implementado no Sprint 2)

**`window.__funil_event_id`**

Propriedade global exposta pelo tracker a cada chamada de `track()`. Contém o `event_id` UUID gerado para o evento mais recente. Serve para que snippets inline de Pixel (e.g. `fbq('track', 'Lead', {eventID: window.__funil_event_id})`) leiam o mesmo identificador de forma síncrona antes de o Pixel disparar, satisfazendo INV-TRACKER-006 (mesmo `event_id` para browser Pixel e CAPI server).

Implementado em `apps/tracker/src/pixel-coexist.ts`, constante `WINDOW_KEY = '__funil_event_id'`.

**sessionStorage com TTL de 5 minutos**

Cada `event_id` gerado é persistido em `sessionStorage` com a chave `__funil_eid_<eventName>` e um campo `expiresAt` (timestamp Unix em ms, TTL = 5 minutos). O TTL de 5 minutos cobre janelas de SPA navigation e hot-reload dentro da mesma sessão de browser, evitando que o Pixel e o CAPI usem ids diferentes em recargas rápidas, sem risco de reutilizar ids entre sessões distintas.

Há dois comportamentos distintos conforme `pixel_policy` (ver `docs/30-contracts/01-enums.md`):

| `pixel_policy` | Função chamada | Comportamento |
|---|---|---|
| `browser_and_server_managed` | `createEventId(eventName)` | Sempre gera novo UUID, sobrescreve entrada em sessionStorage e expõe em `window.__funil_event_id`. |
| `server_only` (ou ausente) | `getOrCreateEventId(eventName)` | Reutiliza entrada válida de sessionStorage se ainda dentro do TTL; caso contrário gera novo UUID. |

Entrada expirada ou ausente no sessionStorage é tratada silenciosamente (INV-TRACKER-007): um novo UUID é gerado e retornado mesmo se o storage não estiver disponível.

## 7.5 Padrões canônicos de snippet por role da page

Cada page de um funil tem um `role` definido em `pages.role` (e refletido em `funnel_template.blueprint.pages[].role`). O role determina o padrão de snippet a aplicar e o valor de `event_config.auto_page_view`.

### Política `auto_page_view` por role

| `role` | `auto_page_view` | Razão |
|---|---|---|
| `sales` (capture, oferta) | `true` | Usuário chega anônimo ou já identificado de sessão anterior — PageView imediato. |
| `webinar` (aula gravada/ao vivo) | `true` | Usuário tipicamente já identificado via `localStorage.__gt_ftk` — snippet faz `F.identify` síncrono, depois tracker dispara PageView. |
| `thankyou` (pós-checkout) | `false` | Snippet faz `F.identify` via URL params **antes** do PageView para que o evento já carregue `lead_token`. |

Esta política é codificada no blueprint do template — ver migration `0039_funnel_template_paid_workshop_v3_auto_page_view.sql` como referência.

### Padrão de snippet por role

Todos os snippets seguem 4 blocos comuns:

1. **`withTracker(cb)`** — polling 50ms × 40 (~2s) até `window.Funil` existir, com fallback silencioso.
2. **`fbqIfAvailable(method, name, customData)`** — helper que dispara `fbq(method, name, customData, { eventID: window.__funil_event_id })`. Garante INV-TRACKER-006 (Pixel + CAPI mesmo `event_id`).
3. **`fbqAutoPageView()`** (apenas em `auto_page_view: true`) — espera `window.__funil_event_id` ser setado pelo tracker e dispara `fbq('track', 'PageView', {}, { eventID })`. Sem isso, o Pixel nunca cria o cookie `_fbp` e cliques anônimos são rejeitados pelo CAPI com `no_user_data`.
4. **`boot()`** + delegated event listeners no `document`.

#### `sales` (capture page — ex: `workshop`, `oferta-principal`)

Responsabilidades:
- `wireBuyButton()` — intercepta click no CTA → `F.track('custom:click_buy_*')` + `fbqIfAvailable('track', 'InitiateCheckout')`.
- `wireForm()` (opcional, se a page tem form de captura) — intercepta submit, POST `/v1/lead` com `consent: { analytics: 'granted', marketing: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', customer_match: 'granted' }`, persiste `lead_token` em `localStorage.__gt_ftk`, chama `F.identify` + `F.track('Lead')` + `fbqIfAvailable('track', 'Lead')`, redireciona ao checkout.
- `fbqAutoPageView()` no `boot()` (PageView fired pelo tracker via `auto_page_view: true`).

Referência completa: [`apps/tracker/snippets/paid-workshop/workshop.html`](../../apps/tracker/snippets/paid-workshop/workshop.html).

#### `webinar` (aula gravada — ex: `aula-workshop`)

Responsabilidades:
- Identity rebind via `localStorage.__gt_ftk` (lead já passou pela capture page).
- `F.page()` manual após identify para garantir PageView com `lead_token` carregado (mesmo que `auto_page_view: true`, o `F.page()` é dedupado pelo `event_id` em sessionStorage).
- `fbqIfAvailable('track', 'PageView')` após `F.page()` para dedup.
- Listener de engagement (ex: click "Já assisti") → `F.track('custom:watched_workshop')` + `fbqIfAvailable('track', 'ViewContent')`.

Referência completa: [`apps/tracker/snippets/paid-workshop/aula-workshop.html`](../../apps/tracker/snippets/paid-workshop/aula-workshop.html).

#### `thankyou` (pós-checkout — ex: `obrigado-workshop`, `obrigado-principal`)

Responsabilidades:
- `readParamsAndStrip()` — lê email/phone/lead_name/utms da query string (vindos do redirect do checkout), depois `history.replaceState` para retirá-los da URL (BR-PRIVACY-001 — não persistir PII em referrers/logs).
- `bootIdentity()` — caminho hot (`__gt_ftk` em localStorage → `F.identify` direto) ou cold (POST `/v1/lead` com email/phone para resolver token).
- `F.page()` **após** identify, com `fbqIfAvailable('track', 'PageView')` logo em seguida.
- Listener opcional para engagement events (ex: click "entrar no WhatsApp" → `F.track('custom:click_wpp_join')` + `fbqIfAvailable('track', 'Contact')`).

Referência completa: [`apps/tracker/snippets/paid-workshop/obrigado-workshop.html`](../../apps/tracker/snippets/paid-workshop/obrigado-workshop.html).

### Consent nos snippets

POST `/v1/lead` deve enviar consent com **todas as 5 finalidades** (BR-CONSENT-001):

```json
"consent": {
  "analytics": "granted",
  "marketing": "granted",
  "ad_user_data": "granted",
  "ad_personalization": "granted",
  "customer_match": "granted"
}
```

Quando o usuário envia o form ou chega na thankyou, ele opted-in. **Nunca enviar booleans (`false`)** — o schema converte mas o backend interpreta `false` como `'denied'`, bloqueando dispatch.

### Ordem de scripts no `<head>`

Os 3 scripts no head devem carregar **nesta ordem**:

1. **GA4 (`gtag.js`)** — para o cookie `_ga` existir antes do tracker capturar cookies.
2. **Meta Pixel (`fbevents.js` via `fbq('init', PIXEL_ID)`)** — sem `fbq('track', 'PageView')` (o snippet de page dispara via `fbqAutoPageView` ou `fbqIfAvailable`).
3. **`tracker.js` do GlobalTracker** — com `data-site-token`, `data-launch-public-id`, `data-page-public-id`, `data-edge-url`.

Se o site usa cache plugin (WP Rocket, LiteSpeed, etc.), os 3 scripts (mais o cookie `gtag` inline) devem ser excluídos das listas de minify, defer e delay. Ver [`docs/70-ux/13-tutorial-instalacao-tracking.md`](../70-ux/13-tutorial-instalacao-tracking.md) §7.

## 7.6 Captura de cookies Meta (`_fbc` / `_fbp`) e fallback via `fbclid`

### Nomes de cookie no browser vs. chaves canônicas no payload

A Meta Pixel SDK escreve os cookies no browser com prefixo underscore:

- Cookie no browser: `_fbc` (click ID) e `_fbp` (browser ID).
- Chave canônica no payload `/v1/events` (CAPI naming): `fbc` e `fbp` (sem underscore).

`capturePlatformCookies` em `apps/tracker/src/cookies.ts` faz a tradução: lê `document.cookie._fbc` / `document.cookie._fbp` e expõe ao restante do tracker sob as chaves `fbc` / `fbp`. **Não inverter** essa convenção — a constante `PLATFORM_COOKIE_NAMES` (= `['_gcl_au', '_ga', 'fbc', 'fbp']`) descreve as chaves de saída, não os nomes lidos no `document.cookie`.

> Bug histórico (commit `748f32e`): durante meses o tracker leu `readCookie('fbc')` / `readCookie('fbp')` (sem underscore) e encontrou sempre `null`, mesmo com Pixel ativo na página. 0 de 713 eventos do workspace alvo carregavam fbc/fbp. Match quality despencou e o Diagnóstico da Meta passou a flaggar "Enviar Identificação do clique da Meta". Qualquer mudança nessa função deve preservar `readCookie('_fbc')` / `readCookie('_fbp')`.

### Fallback `buildFbcFromFbclid()` — sintetiza `_fbc` quando o Pixel não está carregado

Cenário comum: lead chega via Meta Ads em LP que **não** tem o Meta Pixel SDK instalado (ou que bloqueou o Pixel por consent / cache plugin). A URL traz `?fbclid=…`, mas o cookie `_fbc` nunca é escrito porque ninguém o escreveu — e sem `_fbc` o sinal de clique se perde antes de chegar ao backend.

`buildFbcFromFbclid(fbclid)` em `cookies.ts` sintetiza o valor canônico do `_fbc`:

```
fb.{subdomain_index}.{timestamp_ms}.{fbclid}
```

com `subdomain_index = 1` (mesmo valor que o Pixel SDK escreve em uso first-party / domínio raiz). O tracker (`apps/tracker/src/index.ts`, função `buildUserDataRecord(cookies, attribution)`) aplica o fallback **apenas** quando `cookies.fbc` é `null`; cookie real do Pixel sempre vence sobre o sintetizado.

A síntese acontece **no client**, não no server — o `timestamp_ms` reflete o momento em que o lead carregou a página, não o momento em que o backend processou o evento (esse seria errado para a janela de atribuição da Meta).

## 8. BRs relacionadas

- `BR-TRACKER-001` — Funil.identify exige lead_token, não lead_id em claro.
- `BR-CONSENT-*` — Cookies próprios respeitam consent.

## 9. Contratos consumidos

- `CONTRACT-api-config-v1` — endpoint `/v1/config`.
- `CONTRACT-api-events-v1` — endpoint `/v1/events`.
- `CONTRACT-api-lead-v1` — endpoint `/v1/lead`.
- `CONTRACT-event-pageview-v1` etc. — schemas de payload.

## 10. Contratos expostos (API global do bundle)

- `window.Funil.track(eventName, customData?)`
- `window.Funil.identify({lead_token: string})` — único modo aceito.
- `window.Funil.decorate(selectorOrElement)` — propaga attribution + lead_public_id em links de checkout.
- `window.Funil.page()` — dispara PageView manualmente.
- `window.Funil.logout()` — zera `__ftk` no client (não revoga server-side).

## 11. Eventos de timeline emitidos

(Nenhum — tracker é cliente; emite payload a `/v1/events`, mas TE-* são emitidos pelo backend após normalização.)

## 12. Ownership de código

**Pode editar:**
- `apps/tracker/src/index.ts` (entry)
- `apps/tracker/src/cookies.ts`
- `apps/tracker/src/storage.ts`
- `apps/tracker/src/api-client.ts`
- `apps/tracker/src/pixel-coexist.ts`
- `apps/tracker/src/decorate.ts`
- `apps/tracker/build.config.ts`
- `tests/unit/tracker/**`
- `tests/integration/tracker/**` (rodam em jsdom + nock)

**Lê:**
- `packages/shared/src/contracts/events.ts`
- `packages/shared/src/contracts/lead.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `packages/shared` (apenas types/schemas em compile-time).
**Proibidas:** qualquer dependência runtime que aumente bundle. Sem React, lodash, axios, etc.

## 14. Test harness

- `tests/unit/tracker/cookies.test.ts` — INV-TRACKER-003, INV-TRACKER-004, mapeamento `_fbc`/`_fbp` → `fbc`/`fbp` e fallback `buildFbcFromFbclid` (§7.6).
- `tests/unit/tracker/decorate.test.ts` — propagação de UTMs + lead_public_id em links.
- `tests/unit/tracker/pixel-coexist.test.ts` — INV-TRACKER-006 (eventID compartilhado).
- `tests/integration/tracker/identify-only-token.test.ts` — INV-TRACKER-008.
- `tests/integration/tracker/config-fail-degrade.test.ts` — INV-TRACKER-007.
- Build smoke: `tests/build/bundle-size.test.ts` — INV-TRACKER-001.
