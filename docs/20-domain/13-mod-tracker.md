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
- Captura de cookies de plataforma: `_gcl_au`, `_ga`, `fbc`, `fbp`.
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
- `platformCookies` (in-memory após captura — `_gcl_au`, `_ga`, `fbc`, `fbp`)
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

- `tests/unit/tracker/cookies.test.ts` — INV-TRACKER-003, INV-TRACKER-004.
- `tests/unit/tracker/decorate.test.ts` — propagação de UTMs + lead_public_id em links.
- `tests/unit/tracker/pixel-coexist.test.ts` — INV-TRACKER-006 (eventID compartilhado).
- `tests/integration/tracker/identify-only-token.test.ts` — INV-TRACKER-008.
- `tests/integration/tracker/config-fail-degrade.test.ts` — INV-TRACKER-007.
- Build smoke: `tests/build/bundle-size.test.ts` — INV-TRACKER-001.
