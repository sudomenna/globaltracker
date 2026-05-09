# BR-DISPATCH — Regras de dispatch para destinos externos

## BR-DISPATCH-001 — Idempotency key canonicalizada por destino

### Status: Stable (ADR-013)

### Enunciado
```
idempotency_key = sha256(workspace_id|event_id|destination|destination_resource_id|destination_subresource)
```
- `destination_subresource` = `pixel_id` (Meta), `conversion_action` (Google Ads), `measurement_id` (GA4 MP), `audience_id` (Customer Match).
- Constraint `unique (idempotency_key)` em `dispatch_jobs`.

### Enforcement
- Helper `computeIdempotencyKey()` puro.
- DB constraint impede duplicata.

### Gherkin
```gherkin
Scenario: mesmo evento, dois destinos: dois jobs distintos
  Given event=E
  When createDispatchJobs cria job para meta_capi (pixel=P) e ga4_mp (measurement=M)
  Then idempotency_key1 ≠ idempotency_key2

Scenario: retry do mesmo job não cria duplicata
  Given dispatch_job já existe com key=K
  When createDispatchJobs tenta com mesmo input
  Then unique violation; processor reusa job existente
```

---

## BR-DISPATCH-002 — Lock atômico antes de processar; impede duplo-processamento

### Status: Stable (INV-DISPATCH-008)

### Enunciado
Cloudflare Queues entrega at-least-once. Worker **DEVE** fazer UPDATE atômico `status='pending' → 'processing'` antes de chamar plataforma externa. Se UPDATE retornou 0 rows (job já em outro estado), worker abandona sem chamar.

### Enforcement
```ts
const updated = await db.update(dispatchJobs)
  .set({ status: 'processing', updated_at: now() })
  .where(and(eq(id, jobId), eq(status, 'pending')))
  .returning();

if (updated.length === 0) return; // outro consumer já pegou
```

### Gherkin
```gherkin
Scenario: mensagem duplicada na queue não gera 2 chamadas à API
  Given dispatch_job J em status pending
  When 2 consumers recebem mensagem para J simultaneamente
  Then apenas 1 transiciona para processing; outro abandona
  And API externa recebe apenas 1 request
```

---

## BR-DISPATCH-003 — Retry com backoff exponencial + jitter; max 5 attempts

### Status: Stable

### Enunciado
- Erro 4xx permanente (400, 403, 422): `failed`, sem retry.
- Erro 429: `retrying`, backoff exponencial.
- Erro 5xx: `retrying`, backoff exponencial.
- Timeout: `retrying`, backoff exponencial.
- `max_attempts=5` default. Após esgotar: `dead_letter`.

Backoff: `delay = 2^attempt × (1 ± 0.2 random jitter)` segundos.

### Enforcement
- Helper `computeBackoff(attempt: number): number` com Math.random.
- DLQ via CF Queue dead-letter target.

### Gherkin
```gherkin
Scenario: erro 500 → retry 5×, depois DLQ
  Given dispatcher Meta CAPI retorna 500
  When attempt 1, 2, 3, 4, 5 todos falham
  Then status='dead_letter' após attempt 5
  And next_attempt_at = NULL

Scenario: erro 400 não retry
  Given Meta retorna 400 'invalid_pixel_id'
  When dispatcher recebe response
  Then status='failed' imediato (sem retry)
```

---

## BR-DISPATCH-004 — `skipped` exige `skip_reason` não-vazio

### Status: Stable (INV-DISPATCH-004)

### Enunciado
Job com `status='skipped'` **DEVE** ter `skip_reason` preenchido. Razões canônicas:
- `consent_denied:<finality>` (BR-CONSENT-003)
- `no_user_data` (sem email/phone hash para CAPI)
- `integration_not_configured` (workspace sem credenciais)
- `no_click_id_available` (Google Conversion Upload sem gclid)
- `audience_not_eligible` (Customer Match `disabled_not_eligible`)
- `archived_launch`

### Enforcement
- Constraint check: `skip_reason IS NOT NULL when status='skipped'`.

### Gherkin
```gherkin
Scenario: skipped sem reason é rejeitado
  When tentar update dispatch_job com status='skipped' sem skip_reason
  Then check constraint violation
```

---

## BR-DISPATCH-005 — Dead letter não reprocessa automaticamente

### Status: Stable (INV-DISPATCH-003)

### Enunciado
Job em `dead_letter` **NÃO PODE** ser reenvolvido pelo retry automático. Reprocessamento exige ação humana via `requeueDeadLetter(job_id)` chamada por OPERATOR/ADMIN.

### Enforcement
- Helper `requeueDeadLetter()` audita ação em `audit_log`.
- Cron de retry ignora `dead_letter`.

### Gherkin
```gherkin
Scenario: requeue manual move dead_letter para pending
  Given dispatch_job em dead_letter
  When OPERATOR chama requeueDeadLetter(job_id)
  Then status='pending', attempt_count=0, next_attempt_at=now()
  And audit_log com action='reprocess_dlq' criado
```

---

## BR-DISPATCH-006 — Enriquecimento server-side de `user_data` a partir do histórico do lead

### Status: Stable (commit 748f32e — fix Meta CAPI match quality)

### Enunciado

Antes de mapear o payload de saída para um destino que aceita sinais de browser do Meta (`meta_capi`), o dispatcher **DEVE** enriquecer `event.user_data.fbc` e `event.user_data.fbp` a partir do histórico de eventos do mesmo `lead_id` quando o evento corrente está faltando algum dos dois sinais e há lead resolvido.

Regras:

1. Skipar o enrichment quando o evento já tem **ambos** `fbc` e `fbp` populados (caso típico de eventos vindos do tracker.js) — economiza 1 query.
2. Skipar quando não há `lead_id` (eventos puramente anônimos não têm como herdar — continuam usando apenas o que veio no próprio evento).
3. Buscar nos eventos passados do mesmo lead, **workspace-scoped**, ordenados por `received_at DESC`, com `LIMIT 10` (cap de custo). Pegar o `fbc` mais recente não-null e o `fbp` mais recente não-null, **independentemente** — podem vir de eventos diferentes.
4. Cookie real do evento corrente sempre vence sobre o histórico — só preenche o que está faltando, nunca sobrescreve.
5. Quando enriquece, loga `event: 'meta_capi_browser_signals_enriched'` com flags booleanas `enriched_fbc` / `enriched_fbp` (sem leak do valor).

### Razão

Eventos vindos de webhooks (Guru Purchase, SendFlow Contact, Stripe, Hotmart, Kiwify, etc.) chegam com `events.user_data = {}` porque request server-side não tem browser context. Sem o enrichment, eventos Purchase para Meta CAPI nunca carregam `fbc`/`fbp`, mesmo quando o lead foi capturado anteriormente em um PageView/Lead via tracker.js. Meta estima +100% em conversões adicionais reportadas quando `fbc` está presente. Antes do fix em `748f32e`, o Diagnóstico da Meta flaggava "Enviar Identificação do clique da Meta" em todo workspace usando webhooks de checkout.

### Enforcement

- `lookupHistoricalBrowserSignals(db, workspaceId, leadId)` em `apps/edge/src/index.ts` — função pura SQL, retorna `{ fbc: string | null, fbp: string | null }`.
- Chamada dentro de `buildMetaCapiDispatchFn` antes de `mapEventToMetaPayload`.
- Performance: 1 query indexada em `(workspace_id, lead_id)` por dispatch que precise enriquecer.

### Gherkin

```gherkin
Scenario: webhook Purchase herda fbc do PageView anterior do mesmo lead
  Given lead L com event PageView (received_at=T1) carregando user_data.fbc='fb.1.X.abc'
  And event Purchase (received_at=T2 > T1) vindo de webhook Guru com user_data={}
  And dispatch_job para meta_capi do Purchase em pending
  When buildMetaCapiDispatchFn processa o Purchase
  Then lookupHistoricalBrowserSignals retorna { fbc: 'fb.1.X.abc', fbp: null_ou_anterior }
  And payload enviado à Meta CAPI carrega user_data.fbc='fb.1.X.abc'
  And log estruturado contém event='meta_capi_browser_signals_enriched', enriched_fbc=true

Scenario: tracker event com fbc/fbp já presentes — sem enrichment
  Given event PageView vindo do tracker.js com fbc e fbp populados
  When buildMetaCapiDispatchFn processa
  Then lookupHistoricalBrowserSignals NÃO é chamado
  And payload Meta usa exatamente os valores do próprio evento

Scenario: evento sem lead resolvido — sem enrichment
  Given event sem lead_id (visitor anônimo)
  When buildMetaCapiDispatchFn processa
  Then lookupHistoricalBrowserSignals NÃO é chamado
  And payload Meta usa apenas o que está em event.user_data

Scenario: enrichment não sobrescreve sinal já presente
  Given event corrente com user_data.fbc='fb.1.NEW.xyz' (mas sem fbp)
  And lead tem histórico com fbc='fb.1.OLD.abc' e fbp='fb.1.X'
  When buildMetaCapiDispatchFn processa
  Then payload final tem user_data.fbc='fb.1.NEW.xyz' (cookie real venceu)
  And payload final tem user_data.fbp='fb.1.X' (herdado do histórico)
```

### Implicações para novos adapters

Adicionando um novo webhook inbound em `apps/edge/src/routes/webhooks/<provider>.ts`: **não tente** capturar `fbc`/`fbp` do payload da plataforma upstream — eles não estão lá. Resolva o `lead_id` via aliases (email/phone/order_id) e deixe o orchestrator fazer o enrichment no dispatch. Esta BR documenta que esse comportamento é canônico e não acidental.

---

## BR-DISPATCH-007 — `dispatch_attempts.{request,response}_payload_sanitized` reflete o que efetivamente saiu

### Status
Stable (T-DISPATCH-PAYLOAD-AUDIT 2026-05-09).

### Enunciado
Toda função `DispatchFn` (Meta CAPI, GA4 MP, Google Ads conversion, Google Ads enhanced, audience-sync) **DEVE** anexar `request` e `response` no `DispatchResult` retornado. `processDispatchJob` aplica `sanitizeDispatchPayload` (redact `client_ip_address`/`ip`) e grava em `dispatch_attempts.request_payload_sanitized` / `response_payload_sanitized`.

### Motivação
Antes desta BR, ambas colunas gravavam `{}` literal — auditoria de "o que efetivamente saiu pra Meta" era impossível. Caso real (lead `75b3ed42` Pedro, 2026-05-09): typo de email `.con` enviado no primeiro Lead event, `email_hash_external` no DB foi sobrescrito pelo segundo submit `.com`, mas a `v_meta_capi_health` mostra `match_score=8` baseado no estado ATUAL do lead — não no payload realmente enviado. Sem `request_payload_sanitized` populado, não dá pra ver que a Meta recebeu hash de email errado.

### Enforcement
- `DispatchResult` em `apps/edge/src/lib/dispatch.ts` carrega `request?: unknown` e `response?: unknown` (todos os variants via `DispatchPayloadCapture`).
- `processDispatchJob` aplica `sanitizeDispatchPayload` em `apps/edge/src/lib/dispatch-payload-sanitize.ts` antes do INSERT (defesa em profundidade — se o dispatcher esquecer de redactar, a camada captura).
- Sanitização atual: redact `client_ip_address` e `ip` quando string não-vazia. Hashes (em/ph/fn/ln/ct/st/zp/country) preservados (já são SHA-256). User-Agent preservado (não PII per se, útil pra auditoria de match quality).
- Quando o dispatcher não anexar (incremental rollout), grava `{}` legacy.

### Status atual de implementação

| Dispatcher | Captura `request` | Captura `response` |
|---|:---:|:---:|
| `meta_capi` | ✅ | ✅ (incluindo error envelope em 4xx) |
| `ga4_mp` | ⏳ pending | ⏳ pending |
| `google_ads_conversion` | ⏳ pending | ⏳ pending |
| `google_ads_enhanced` | ⏳ pending | ⏳ pending |
| `audience_sync` | ⏳ pending | ⏳ pending |

Incremental — adicionar `request: payload, response: <body>` ao `return` de cada `buildXxxDispatchFn` quando tocar.

### Critérios de aceite

```gherkin
Scenario: Meta CAPI Lead succeeded — request e response gravados sem PII em claro
  Given Lead event com lead_id e fbc/fbp populados
  And launch tem pixel_id válido + capi_token
  When dispatcher Meta CAPI processa o job e Meta retorna 200
  Then dispatch_attempts.status='succeeded'
  And request_payload_sanitized.user_data.client_ip_address='[REDACTED]'
  And request_payload_sanitized.user_data.em é hash SHA-256 (64 hex chars)
  And request_payload_sanitized.user_data.client_user_agent é UA string em claro
  And response_payload_sanitized contém events_received, fbtrace_id, messages

Scenario: Meta CAPI 400 — error envelope gravado para auditoria
  Given Lead event que vai falhar com 400 Bad Request
  When dispatcher Meta CAPI processa
  Then dispatch_attempts.status='permanent_failure'
  And request_payload_sanitized populado (mesma sanitização)
  And response_payload_sanitized contém envelope.error.code, envelope.error.message
```

### Citação em código

```ts
// BR-DISPATCH-007: anexar request/response ao DispatchResult — sanitize aplicado em processDispatchJob
return { ok: true, request: payload, response: capiResult.data };
```
