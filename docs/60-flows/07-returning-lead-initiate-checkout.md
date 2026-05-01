# FLOW-07 — Lead retornante dispara InitiateCheckout

## Gatilho
Lead que se cadastrou em T0 retorna à mesma LP em T+5d e clica em CTA de checkout.

## Atores
PERSONA-LEAD (browser); sistema.

## UC envolvidos
UC-007 (novo em v3.0 do `planejamento.md`).

## MOD-* atravessados
`MOD-TRACKER`, `MOD-EVENT`, `MOD-IDENTITY` (lead_token validation), `MOD-DISPATCH`.

## CONTRACT-* envolvidos
`CONTRACT-api-events-v1`, `CONTRACT-lead-token-v1`, `40-integrations/01-meta-capi.md`.

## BRs aplicadas
BR-IDENTITY-005 (lead_token binding), BR-EVENT-006 (lead_token resolve lead_id), BR-CONSENT-004 (cookie depende de consent), BR-DISPATCH-001/002 (idempotency, lock).

## Fluxo principal

1. Lead L se cadastrou em T0 em `lp.cliente.com/captura-v3`. `/v1/lead` emitiu `lead_token` HMAC com claim `{workspace_id, lead_id=L, page_token_hash=H1, exp=T0+60d}`. Backend setou `Set-Cookie: __ftk=<token>; SameSite=Lax; Secure`.
2. Em T+5d, lead retorna a `lp.cliente.com/sales` (página de vendas — page diferente, mas mesmo workspace/launch e mesma config de PageToken).
3. `tracker.js` carrega: lê cookie `__ftk` do domínio `cliente.com`. Valor está em memória durante session.
4. Tracker dispara PageView via `POST /v1/events` com `lead_token` no body.
5. Edge valida:
   - `X-Funil-Site` (page_token da page atual `/sales`).
   - Recupera `page_token` row → hash atual `H_current`.
   - `validateLeadToken(token, H_current)`:
     - HMAC válido com `LEAD_TOKEN_HMAC_SECRET` ✓
     - Claim `exp` > now() ✓
     - Claim `page_token_hash=H1` vs `H_current` — se igual, ✓; se rotação aconteceu, mas H1 ainda é hash de algum token em status `active` ou `rotating`, ✓.
     - `lead_token.revoked_at IS NULL` ✓
6. Edge persiste em `raw_events` com payload incluindo `lead_id=L` resolvido. Retorna 202.
7. Lead clica em CTA "Comprar agora". Tracker dispara `InitiateCheckout` via `POST /v1/events` com `lead_token`, `custom_data: {value: 29700, currency: 'BRL'}`.
8. Mesmo fluxo de validação (step 5-6).
9. Ingestion processor cria event row com `event_name='InitiateCheckout'`, `lead_id=L`, `consent_snapshot` capturado.
10. Processor cria `dispatch_jobs` para Meta CAPI (InitiateCheckout), GA4 MP, Google Ads (sem conversion upload — InitiateCheckout não é conversão padrão Google).
11. Worker Meta CAPI:
    - Eligibility: `consent_snapshot.ad_user_data='granted'` ✓; `lead_id=L` populado ✓.
    - Lookup `leads`: pega `email_hash`, `phone_hash`, recupera `fbc`, `fbp` de cookies capturados em `events.user_data`.
    - Mapper monta payload com `event_name='InitiateCheckout'`, `event_id`, `value`, `currency`, `user_data` enriquecido.
    - POST a Meta. **Browser nunca reenviou PII** — mas Meta recebe match completo.
12. Meta retorna 200; dispatch_job → `succeeded`.
13. MARKETER vê em dashboard `InitiateCheckout` count + match quality elevado.

## Fluxos alternativos

### A1 — `__ftk` expirado

5'. `lead_token.exp < now()` (passou janela TTL):
   - `validateLeadToken` retorna error `Expired`.
   - Edge aceita evento como **anônimo** (`lead_id` removido do payload antes de raw_events).
   - Métrica `lead_token_validation_failures{reason='expired'}` incrementa.
   - Tracker continua emitindo eventos, mas sem identidade até próximo `/v1/lead`.

### A2 — `__ftk` com `page_token_hash` mismatch (page rotacionou após janela)

5''. Operador rotacionou page_token de `/sales` há 30 dias; janela de overlap (14d) já expirou; H1 do claim refere a token agora `revoked`.
   - `validateLeadToken` retorna error `PageMismatch`.
   - Tratado como anônimo.
   - Lead precisa re-cadastrar para receber novo `__ftk`.

### A3 — Cookie `__ftk` removido pelo lead (consent revogado)

3'. Lead limpou cookies do browser ou usou modo anônimo:
   - Tracker não encontra `__ftk`.
   - Eventos vão como anônimos.
   - Comportamento esperado e respeitado por privacidade.

### A4 — `__ftk` cross-domain (lead em LP cliente1.com, agora em cliente2.com)

3''. Cliente operador tem múltiplos workspaces ou mudou domínio:
   - Cookie `__ftk` é setado por domínio. Não atravessa entre domínios.
   - Lead vê tracker.js de cliente2.com como visitor anônimo.
   - Reidentificação só via `/v1/lead` novamente.

### A5 — XSS em LP rouba `__ftk`

Cenário de segurança: atacante injeta script em LP comprometida, exfiltra `__ftk`.
- Mitigação 1: TTL curto (60d default — operador pode reduzir).
- Mitigação 2: Binding ao `page_token_hash` — token roubado não funciona em outras pages.
- Mitigação 3: PRIVACY/ADMIN podem revogar `lead_tokens.revoked_at` em massa via admin tool.
- Mitigação 4: SAR re-emite token (revoga antigo via audit-trailed endpoint).

## Pós-condições

- Eventos PageView e InitiateCheckout em `events` com `lead_id` populado.
- Meta CAPI recebeu eventos com `user_data` enriquecido server-side.
- Match quality em Meta sobe (mais sinais → melhor attribution na plataforma).

## TE-* emitidos

- TE-EVENT-INGESTED-v1, TE-EVENT-NORMALIZED-v1
- TE-DISPATCH-CREATED-v1, TE-DISPATCH-SUCCEEDED-v1

## Casos de teste E2E

1. **Happy path** — lead cadastra em T0, `__ftk` setado, retorna em T+5d, InitiateCheckout vai a Meta com user_data.
2. **`__ftk` expirado** — TTL 0 em test config; segundo evento é anônimo.
3. **Page mismatch** — page_token rotacionado fora da janela; validator falha com PageMismatch; evento anônimo.
4. **Sem cookie** — modo anônimo; eventos sem lead_id.
5. **Revogação ativa** — `lead_tokens.revoked_at` setado; próximo evento com mesmo token falha.
