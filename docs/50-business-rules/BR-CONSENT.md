# BR-CONSENT — Regras de consentimento

## BR-CONSENT-001 — Consent é capturado por finalidade, não global

### Status: Stable (ADR-010)

### Enunciado
Sistema **DEVE** capturar 5 finalidades distintas: `analytics`, `marketing`, `ad_user_data`, `ad_personalization`, `customer_match`. Cada finalidade aceita 3 valores: `granted`, `denied`, `unknown`. Booleano único `consent: true/false` é proibido.

### Enforcement
- Zod schema `ConsentSchema` em `packages/shared/` exige todas 5 finalidades.
- `lead_consents` tem 5 colunas separadas + constraint check.

### Aplica-se a
MOD-IDENTITY, MOD-EVENT, MOD-DISPATCH.

### Gherkin
```gherkin
Scenario: payload com booleano global é rejeitado
  Given POST /v1/lead com consent: true
  When Edge valida
  Then retorna 400 'consent_must_be_object'
```

### Citação
```ts
// BR-CONSENT-001: consent granular por finalidade, não booleano
```

---

## BR-CONSENT-002 — Snapshot de consent é capturado em todo evento

### Status: Stable

### Enunciado
Cada row em `events` **DEVE** ter `consent_snapshot` (jsonb) populado com as 5 finalidades — mesmo que `unknown` para todas. Campo nunca é NULL.

### Enforcement
- Zod schema requer `consent` no payload.
- Ingestion processor copia consent recebido para `events.consent_snapshot`.
- Em ausência de consent no payload (eventos legacy), default para `unknown` em todas finalidades + log warn.

### Gherkin
```gherkin
Scenario: evento sem consent recebe default unknown
  Given POST /v1/events sem campo consent
  When ingestion processor normaliza
  Then events.consent_snapshot = { analytics: 'unknown', marketing: 'unknown', ... }
```

### Citação
```ts
// BR-CONSENT-002: consent_snapshot obrigatório em events
```

---

## BR-CONSENT-003 — Dispatcher bloqueia destino quando consent exigido for `denied` ou `unknown`

### Status: Stable

### Enunciado
Cada destination tem mapping de finalidades exigidas:
- `meta_capi` (eventos com PII): `ad_user_data` granted.
- `meta_capi` (PageView sem PII): nenhuma exigência (apenas `analytics` recomendado).
- `ga4_mp`: `analytics` granted.
- `google_ads_conversion`: `ad_user_data` granted.
- `google_enhancement`: `ad_user_data` granted.
- `audience_sync` (Customer Match): `customer_match` granted + `ad_personalization` granted.

Dispatcher **DEVE** marcar job como `skipped` com `skip_reason='consent_denied'` quando finalidade exigida não estiver `granted`.

### Enforcement
- Eligibility check em `apps/edge/src/dispatchers/index.ts` antes de enviar.
- Snapshot consultado em `events.consent_snapshot`, não em `lead_consents` corrente (evita race condition).

### Gherkin
```gherkin
Scenario: Lead event com ad_user_data=denied é skipped no Meta CAPI
  Given event com consent_snapshot.ad_user_data='denied'
  When dispatcher Meta CAPI processa
  Then dispatch_job.status='skipped', skip_reason='consent_denied:ad_user_data'

Scenario: PageView sem ad_user_data ainda dispatcha (não exige PII)
  Given PageView com consent_snapshot.analytics='granted', ad_user_data='unknown'
  When dispatcher Meta CAPI processa
  Then dispatcha sem PII (apenas fbc/fbp)
```

### Citação
```ts
// BR-CONSENT-003: skip dispatch quando consent exigido != granted
```

---

## BR-CONSENT-004 — Cookies próprios `__fvid` e `__ftk` exigem `consent_analytics='granted'`

### Status: Stable

### Enunciado
`tracker.js` **NÃO PODE** setar `__fvid` (Fase 3) ou backend setar `__ftk` (Fase 2) quando `consent_analytics != 'granted'`.

### Enforcement
- Tracker: lógica em `apps/tracker/src/cookies.ts` checa consent antes de setar.
- Backend: `/v1/lead` só envia `Set-Cookie: __ftk` quando consent recebido inclui `analytics=granted`.

### Gherkin
```gherkin
Scenario: __ftk não é setado quando analytics denied
  Given POST /v1/lead com consent.analytics='denied'
  When response retorna 202
  Then resposta NÃO contém Set-Cookie: __ftk
  And lead_token continua sendo emitido (no body) — mas tracker não persiste cookie

Scenario: __fvid não é gerado em LP sem consent
  Given consent_analytics='denied' em config
  When tracker.js inicializa
  Then __fvid não é gerado nem setado
```

### Citação
```ts
// BR-CONSENT-004: cookies próprios exigem consent_analytics granted
```
