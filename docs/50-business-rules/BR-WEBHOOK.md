# BR-WEBHOOK — Regras de webhooks inbound

## BR-WEBHOOK-001 — Assinatura validada em raw body antes de parse

### Status: Stable (ADR-022 para Stripe)

### Enunciado
Cada adapter **DEVE** validar assinatura sobre raw body (não parsed JSON). Comparação em tempo constante (`crypto.timingSafeEqual`). Stripe usa `constructEvent` com tolerância 5min.

### Enforcement
- Handler em `apps/edge/src/routes/webhooks/<provider>.ts` lê raw body via `c.req.raw.text()`.
- Falha de assinatura → 400 imediato sem processar.

### Gherkin
```gherkin
Scenario: Stripe webhook com assinatura inválida
  Given POST /v1/webhook/stripe com Stripe-Signature inválido
  When adapter valida via constructEvent
  Then 400 'invalid_signature'
  And payload não é processado
  And métrica webhook_signature_failures incrementa

Scenario: Hotmart com hottok correto
  Given POST /v1/webhook/hotmart com X-Hotmart-Hottok correto
  When adapter valida
  Then aceita e processa
```

---

## BR-WEBHOOK-002 — `event_id` derivado de `platform_event_id` para idempotência

### Status: Stable (ADR-019)

### Enunciado
```
event_id = sha256(platform || ':' || platform_event_id)[:32]
```
Combinado com `unique (workspace_id, event_id)` em `events`, retry da plataforma cai na constraint e adapter retorna idempotente.

### Enforcement
- Helper `deriveEventId()` em cada adapter.
- Test: enviar mesmo webhook 3× cria 1 evento.

### Gherkin
```gherkin
Scenario: Stripe envia mesmo event 3×
  Given event.id = 'evt_xyz' enviado 3× em sequência (network retry)
  When adapter processa cada request
  Then events count com event_id derivado = 1
  And cada request retorna 202
```

---

## BR-WEBHOOK-003 — Eventos não mapeáveis vão para DLQ, não rejeitam 4xx

### Status: Stable

### Enunciado
Mapper que falha (payload inesperado, evento desconhecido) **DEVE** marcar `raw_events.processing_status='failed'` mas adapter responde 2xx para a plataforma — porque 4xx-5xx faria provedor retry forever.

### Enforcement
- Catch em mapper → `raw_events.processing_error='mapping_failed:...'` + 200 ao caller.

### Gherkin
```gherkin
Scenario: Hotmart envia evento futuro desconhecido
  Given payload com event_type='NEW_FUTURE_EVENT' não mapeado
  When adapter processa
  Then 200 ao Hotmart (não retry)
  And raw_events status='failed', error='unknown_event_type'
  And alerta operacional para investigação
```

---

## BR-WEBHOOK-004 — Hierarquia de associação de identidade (1) lead_public_id → ... → (5) janela temporal

### Status: Stable (Seção 17 do planejamento)

### Enunciado
Adapter associa webhook a lead nesta ordem:
1. `metadata.lead_public_id` (alta confiança)
2. `order_id` / `client_reference_id` previamente criado (alta)
3. Email/phone hashado consultando `lead_aliases` (média/alta)
4. Click IDs propagados (`gclid`, `fbclid`) (média)
5. Janela temporal + campanha + valor (baixa — apenas sugestão, nunca associação automática forte)

Heurísticas (passo 5) **NÃO PODEM** sobrescrever associação forte (passos 1-2).

### Enforcement
- Função `associateLead()` em cada adapter implementa cascata.
- Log indica em qual passo a associação foi feita.

### Gherkin
```gherkin
Scenario: lead_public_id propagado wins
  Given webhook com metadata.lead_public_id=PID
  When associateLead executa
  Then resolve por PID, ignora email match alternativo
  And associação_method='lead_public_id'

Scenario: sem identificadores fortes; email match
  Given webhook sem lead_public_id, sem order_id, com customer.email
  When email_hash matches lead em lead_aliases
  Then associa por email; método='email_hash'

Scenario: heurística temporal nunca sobrescreve
  Given webhook tem order_id='X' (associado a lead L)
  And janela temporal sugere lead M (compra recente)
  When associateLead executa
  Then resolve para L (passo 2 ganha de passo 5)
```
