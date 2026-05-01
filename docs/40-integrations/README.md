# 40 — Integrações externas

Um arquivo por provedor. Diretrizes universais aqui; particularidades em cada arquivo.

| Arquivo | Provedor | Tipo |
|---|---|---|
| `01-meta-capi.md` | Meta Conversions API | dispatch out |
| `02-meta-custom-audiences.md` | Meta Custom Audiences | audience sync out |
| `03-google-ads-conversion-upload.md` | Google Ads Conversion Upload | dispatch out |
| `04-google-ads-enhanced-conversions.md` | Google Ads Enhanced Conversions | adjustment out |
| `05-google-customer-match.md` | Customer Match (Data Manager API / allowlisted) | audience sync out |
| `06-ga4-measurement-protocol.md` | GA4 MP | dispatch out |
| `07-hotmart-webhook.md` | Hotmart | webhook in |
| `08-kiwify-webhook.md` | Kiwify | webhook in |
| `09-stripe-webhook.md` | Stripe | webhook in |
| `10-webinarjam-webhook.md` | WebinarJam (Fase 3) | webhook in |
| `11-typeform-tally-webhook.md` | Typeform/Tally (Fase 3) | webhook in |
| `12-fx-rates-provider.md` | Provedor de taxa cambial (ECB/Wise/manual) | data fetch in |

## Diretrizes universais

1. **Idempotência obrigatória.** Webhooks: derivar `event_id = sha256(platform || ':' || platform_event_id)[:32]`. Dispatch: `idempotency_key` por destino conforme `30-contracts/05-api-server-actions.md`.
2. **Assinatura ou allowlist.** Webhooks sem assinatura nativa exigem token dedicado + IP allowlist quando possível.
3. **Retry com backoff exponencial + jitter.** 4xx permanente → `failed`. 429/5xx → `retrying` até `max_attempts`. Após limite → DLQ.
4. **Credenciais via env vars.** Nunca em código. Rotação documentada por provedor.
5. **Fixtures de teste** em `tests/fixtures/<provider>/`. Cada adapter tem fixture de webhook real ou representativo.
6. **Adapters vivem em** `apps/edge/src/dispatchers/<provider>/` (out) ou `apps/edge/src/routes/webhooks/<provider>.ts` (in). Funções obrigatórias: `validateSignature()`, `mapToInternal()`, `handleWebhook()`.
