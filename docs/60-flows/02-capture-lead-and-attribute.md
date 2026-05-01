# FLOW-02 — Capturar lead e atribuir origem

## Gatilho
Visitante acessa LP via link de campanha, preenche form de captura.

## Atores
PERSONA-LEAD, sistema.

## UC envolvidos
UC-002.

## MOD-* atravessados
`MOD-PAGE`, `MOD-EVENT`, `MOD-IDENTITY`, `MOD-ATTRIBUTION`, `MOD-FUNNEL`, `MOD-DISPATCH` (criação de jobs).

## CONTRACT-* envolvidos
`CONTRACT-api-config-v1`, `CONTRACT-api-redirect-v1`, `CONTRACT-api-events-v1`, `CONTRACT-api-lead-v1`, `CONTRACT-lead-token-v1`.

## BRs aplicadas
BR-IDENTITY-001 a 005, BR-PRIVACY-003 (PII enc), BR-CONSENT-001 a 004, BR-EVENT-001 a 006, BR-ATTRIBUTION-001 a 002, BR-WEBHOOK-004 (associação).

## Fluxo principal

1. Lead clica em link de campanha Meta: `https://r.cdn.com/lcm-meta-cold-v3?fbclid=ABC&gclid=XYZ`.
2. Redirector resolve `slug=lcm-meta-cold-v3` → `destination_url=https://lp.cliente.com/?utm_source=meta&utm_campaign=...`. Registra `link_clicks` async.
3. Browser segue 302; `tracker.js` carrega na LP.
4. Tracker faz `GET /v1/config/...`, recebe `event_config`.
5. Tracker captura UTMs + `fbclid`/`gclid` + `fbc`/`fbp` cookies + `_gcl_au` + referrer; persiste em `localStorage`.
6. Tracker dispara PageView (`POST /v1/events`).
7. Lead preenche form (email, phone, name, consent_ads). Submit → tracker dispara `POST /v1/lead` com payload completo + attribution params do localStorage.
8. Edge valida (token, CORS, schema, replay protection, clamp event_time, bot mitigation), persiste em `raw_events`, retorna 202 com `lead_token` + `Set-Cookie: __ftk` (apenas se consent_analytics=granted).
9. Ingestion processor (async): chama `resolveLeadByAliases({email, phone})`. Retorna 0 leads → cria novo Lead com PII hash + enc + `pii_key_version=1`. Cria 2 aliases (email_hash, phone_hash) `active`.
10. Processor cria `lead_consents` row (5 finalidades + `policy_version`).
11. Processor cria `lead_attribution` row para `touch_type='first'` (e `last`) com UTMs + click IDs.
12. Processor cria `lead_stages` row `stage='registered'`, `is_recurring=false`.
13. Processor insere row em `events` com `event_name='Lead'`, `lead_id=L`, `consent_snapshot`.
14. Processor cria `dispatch_jobs` para destinos elegíveis: Meta CAPI (Lead event), GA4 MP (Lead event), Google Ads conversion (se `gclid` válido + conversion_action mapeado).
15. Workers de dispatch processam jobs → resultado em `dispatch_attempts`.
16. MARKETER vê lead aparecer em dashboard.

## Fluxos alternativos

### A1 — Lead já existe (mesma email)

9'. `resolveLeadByAliases` encontra 1 lead (mesmo email_hash):
   - Atualiza `last_seen_at`.
   - Adiciona alias para phone_hash se ainda não existe.
   - First-touch preservado; last-touch atualizado se novo evento de conversão.

### A2 — Convergência triggera merge

9''. `resolveLeadByAliases` encontra 2 leads (A com email-only, B com phone-only):
   - Executa merge canônico (BR-IDENTITY-003).
   - Lead A (mais antigo) é canonical; B → status=`merged`, `merged_into_lead_id=A`.
   - Aliases de B movem para A (B → `superseded`).
   - Events/attribution/stages de B reapontam para A.
   - `lead_merges` row criada com `before_summary`/`after_summary`.
   - `audit_log` entry com `action='merge_leads'`.
   - Continue fluxo normal com `lead_id=A`.

### A3 — Consent denied bloqueia dispatch

14'. `consent_snapshot.ad_user_data='denied'`:
   - Dispatcher Meta CAPI cria job mas marca `status='skipped'` com `skip_reason='consent_denied:ad_user_data'`.
   - Dispatcher Google idem.
   - Lead permanece em DB; analytics/funnel funcionam; ads dispatch bloqueado.

### A4 — Replay (mesmo event_id)

8'. `event_id` já visto nos últimos 7d (KV cache):
   - Edge retorna 202 `{status: 'duplicate_accepted'}`.
   - Não persiste em `raw_events`.
   - Tracker tratará como sucesso.

### A5 — Bot mitigation rejeita

8''. Honeypot preenchido + tempo de submit < 1s:
   - Edge retorna 400 `bot_detected`.
   - Métrica `bot_rejections_total` incrementa.

## Pós-condições

- Lead criado/atualizado em `leads`; aliases ativos.
- `lead_consents` populado.
- `lead_attribution` first + last preenchidos.
- `lead_stages` com `stage='registered'`.
- Events row criada.
- Cookie `__ftk` setado no browser (se consent_analytics=granted).
- Dispatch jobs criados para Meta/Google.

## TE-* emitidos

- TE-EVENT-INGESTED-v1, TE-EVENT-NORMALIZED-v1
- TE-LEAD-CREATED-v1 (ou TE-LEAD-UPDATED-v1)
- TE-LEAD-MERGED-v1 (caso A2)
- TE-LEAD-CONSENT-RECORDED-v1
- TE-LEAD-TOKEN-ISSUED-v1
- TE-FIRST-TOUCH-RECORDED-v1, TE-LAST-TOUCH-UPDATED-v1
- TE-LEAD-STAGE-RECORDED-v1
- TE-DISPATCH-CREATED-v1 × N (por destino)

## Erros previstos

| Erro | HTTP | Quando |
|---|---|---|
| `validation_error` | 400 | Zod schema falhou |
| `missing_identifier` | 400 | Sem email nem phone |
| `bot_detected` | 400 | Honeypot/timing |
| `invalid_token` | 401 | page_token errado |
| `origin_not_allowed` | 403 | CORS |
| `rate_limited` | 429 | Quota |

## Casos de teste E2E sugeridos

1. **Happy path** com Meta link, captura completa, lead criado, jobs criados.
2. **Convergência merge** (A2): 2 leads pré-existentes fundem.
3. **Consent denied** (A3): jobs ad criados mas skipped.
4. **First-touch isolado por launch**: lead em launch A → reaparece em launch B → first-touch novo para B.
