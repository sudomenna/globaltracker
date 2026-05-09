# BR-EVENT — Regras de ingestão e processamento de eventos

## BR-EVENT-001 — Edge persiste em `raw_events` antes de retornar 202

### Status: Stable (ADR-004)

### Enunciado
`/v1/events` e `/v1/lead` **DEVEM** completar `INSERT INTO raw_events` antes de retornar `202`. Cliente nunca recebe 202 sem evento durável em DB.

### Enforcement
- Handler em `apps/edge/src/routes/events.ts` aguarda insert antes do response.
- Test simula crash do worker e confirma que cliente vê erro de network, não 202 espúrio.

### Gherkin
```gherkin
Scenario: kill -9 antes do response não gera 202 espúrio
  Given POST /v1/events em flight
  When worker é morto após validar mas antes de inserir em raw_events
  Then cliente recebe network error (não 202)
  And nenhum row em raw_events para esse event_id

Scenario: 202 garantido durável
  Given POST /v1/events bem-sucedido com 202
  When buscar raw_events com mesmo event_id
  Then row existe com processing_status='pending'
```

### Citação
```ts
// BR-EVENT-001: insert raw_events antes de 202
```

---

## BR-EVENT-002 — Idempotência por `(workspace_id, event_id)` em events

### Status: Stable (RNF-004)

### Enunciado
Insert em `events` **DEVE** ser idempotente por `unique (workspace_id, event_id)`. Se já existe, ingestion processor retorna sem criar novo row e sem criar novos `dispatch_jobs`.

### Enforcement
- Constraint DB.
- Processor catch error de unique violation → marca raw_event como `processed` com nota `duplicate`.
- Edge cache replay protection (KV TTL 7d) faz primeira camada de defesa.

### Gherkin
```gherkin
Scenario: replay de mesmo event_id retorna duplicate
  Given event já processado com event_id=X
  When POST /v1/events com mesmo event_id=X
  Then resposta = 202 { status: 'duplicate_accepted' }
  And events count com X = 1 (não duplicado)
  And dispatch_jobs count para X = mesmo (não criou novos)
```

### Citação
```ts
// BR-EVENT-002: idempotência por (workspace_id, event_id)
```

---

## BR-EVENT-003 — `event_time` é clampado quando offset > `EVENT_TIME_CLAMP_WINDOW_SEC`

### Status: Stable (ADR-020, RF-027)

### Enunciado
Edge **DEVE** aplicar:
```
if abs(event_time - received_at) > EVENT_TIME_CLAMP_WINDOW_SEC: event_time = received_at
```
Default window: 300s (5min). Métrica `event_time_clamps` registra ocorrência.

### Enforcement
- `clampEventTime()` em `apps/edge/src/lib/event-time-clamp.ts`.
- Edge chama antes de validar payload completo.

### Gherkin
```gherkin
Scenario: relógio do cliente atrasado em 1 hora
  Given received_at = "2026-05-01T20:00:00Z"
  And payload event_time = "2026-05-01T19:00:00Z"
  When Edge processa
  Then event_time efetivo = received_at
  And métrica event_time_clamps incrementa

Scenario: offset dentro de janela é preservado
  Given offset = 30s (network/clock natural)
  When clampEventTime aplica
  Then event_time preservado
```

### Citação
```ts
// BR-EVENT-003: clamp event_time quando offset > 300s
```

---

## BR-EVENT-004 — Replay protection via KV cache TTL 7 dias

### Status: Stable (ADR-021)

### Enunciado
Edge **DEVE** consultar `KV_REPLAY_PROTECTION` para `event_id` no início do request. Se já visto nos últimos 7 dias, retorna `{status: 'duplicate_accepted'}` sem persistir em `raw_events`.

### Enforcement
- Helper `isReplay()` e `markReplayProtectionSeen()` em `apps/edge/src/lib/replay-protection.ts`.
- TTL natural do KV = 7 dias. Sem manutenção.

### Gherkin
```gherkin
Scenario: replay rejeitado pelo KV
  Given event_id=X já visto em T0
  When POST /v1/events com event_id=X em T+1d
  Then 202 { status: 'duplicate_accepted' }
  And raw_events não recebe novo insert
  And total roundtrips = apenas 1 KV read

Scenario: replay aceito após 7d
  Given event_id=X visto em T0
  When POST com event_id=X em T+8d (TTL expirou)
  Then aceita normalmente como novo evento
```

### Citação
```ts
// BR-EVENT-004: KV replay protection TTL 7d
```

---

## BR-EVENT-005 — `events.user_data` aceita apenas chaves canônicas (sem PII em claro)

### Status: Stable (BR-PRIVACY-001 reforço; jsonb storage type clarification 2026-05-09)

### Enunciado
`user_data` jsonb aceita apenas: `em` (email_hash), `ph` (phone_hash), `external_id_hash`, `fbc`, `fbp`, `_gcl_au`, `client_id_ga4`, `session_id_ga4`, `client_ip_address`, `client_user_agent`, `geo_city`, `geo_region_code`, `geo_postal_code`, `geo_country`. Chaves desconhecidas ou PII em claro (`email`, `phone`, `name`, `ip`) são rejeitadas.

**Storage type — jsonb-object obrigatório.** Writes em `events.user_data` (e em qualquer coluna jsonb tocada pelo edge worker) **devem** usar o helper `jsonb()` em `apps/edge/src/lib/jsonb-cast.ts` para garantir `jsonb_typeof='object'`. Sem o helper, o driver Hyperdrive serializa o valor como text-com-aspas e Postgres aceita como jsonb-string — operadores `->`/`->>` falham silenciosamente em queries SQL ad-hoc. Detalhe completo em [`30-contracts/02-db-schema-conventions.md`](../30-contracts/02-db-schema-conventions.md#writes-via-hyperdrive--helper-jsonb-obrigatório-t-13-013-followup-2026-05-09). Aplicado em todos os 4 raw-events-processors + `dispatch.ts` + `index.ts` desde commit `22db9a9` (deploy `ed9a490d`, 2026-05-09).

### Enforcement
- Zod schema `UserDataSchema.strict()` em `apps/edge/src/lib/raw-events-processor.ts` rejeita keys desconhecidas e PII keys (`email`, `phone`, `name`, `ip`).
- Helper `jsonb()` em todos os call sites de `db.insert(events).values({ user_data: ... })` garante storage type correto.
- Reads precisam de parse defensivo (`(user_data #>> '{}')::jsonb` em SQL ou `typeof row.userData === 'string' ? JSON.parse(...) : row.userData` em TS) para tolerar rows pré-deploy `ed9a490d`.

### Gherkin
```gherkin
Scenario: user_data com email em claro rejeitado
  Given POST /v1/events com user_data: { email: "foo@bar.com" }
  When Edge valida
  Then 400 com error_code='validation_error_user_data_pii'
```

### Citação
```ts
// BR-EVENT-005: user_data canonical only
```

---

## BR-EVENT-006 — Eventos com lead_token válido têm lead_id resolvido server-side

### Status: Stable (RF-024)

### Enunciado
Quando `/v1/events` recebe `lead_token` válido (HMAC verifica + page_token_hash bind ok + não expirado + não revogado), ingestion processor **DEVE** popular `events.lead_id` a partir do claim. Falha de validação resulta em evento aceito como anônimo (sem `lead_id`) + métrica.

### Enforcement
- Edge valida em `validateLeadToken()`. Inválido → drop lead_id antes de raw_events.
- Falha não derruba evento (tracker pode ter token corrompido legítimo).

### Gherkin
```gherkin
Scenario: lead_token válido resolve
  Given lead_token assinado válido para lead_id=L
  When POST /v1/events com lead_token
  Then events.lead_id = L (após processor)

Scenario: lead_token expirado é tratado anônimo
  Given lead_token com exp < now()
  When POST /v1/events com lead_token
  Then events.lead_id IS NULL
  And métrica lead_token_validation_failures(reason='expired') incrementa
```

### Citação
```ts
// BR-EVENT-006: lead_token válido popula lead_id; inválido vira anônimo
```
