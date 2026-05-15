# 07 — Observabilidade

## Princípios

1. **Logs sanitizados sempre.** Zero PII (BR-PRIVACY-001).
2. **Métricas estruturadas.** Não usar logs para contar — usar métrica.
3. **Correlation ID.** `request_id` propagado em todos logs e responses.
4. **Saúde técnica + saúde de negócio.** Dashboard técnico (operacional) ≠ dashboard de produto (CPL/ROAS).

## Camadas

| Camada | Tecnologia | Conteúdo |
|---|---|---|
| Logs estruturados | Cloudflare Logpush ou Workers tail | JSON com request_id, level, event |
| Métricas | Cloudflare Workers Analytics + Workers Logs | Counters, latência |
| Traces | (opcional Fase 4+) Cloudflare Workers + OTel | Distributed tracing |
| Audit log (compliance) | Postgres `audit_log` | Mutações sensíveis |
| Dashboard técnico | Metabase consumindo `dispatch_health_view`, etc. | Operacional |
| Dashboard produto | Metabase consumindo rollups | Negócio |

## Logger central

```ts
// apps/edge/src/middleware/sanitize-logs.ts
export type LogPayload = Record<string, unknown> & { request_id?: string };

export function log(level: 'info' | 'warn' | 'error', msg: string, payload?: LogPayload) {
  const sanitized = sanitize(payload); // remove PII keys
  console.log(JSON.stringify({
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...sanitized,
  }));
}
```

Toda função em `apps/edge/` usa `log()`, não `console.log` direto.

## Request ID

Middleware gera UUID em cada request se não vier de upstream. Propagado em:
- Headers: `X-Request-Id` (response).
- Logs: `request_id` field.
- DB: `audit_log.request_context.request_id`.
- Errors: `error.request_id` para suporte rastrear.

```ts
app.use(async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('request_id', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});
```

## Métricas de negócio

Coletadas via inserts em `events`/`dispatch_jobs`/`audience_sync_jobs`. Visualizadas em Metabase rollups:

- `events_received_total{workspace, launch, page, event_name}`
- `leads_created_total{workspace, launch}`
- `lead_merges_executed_total{workspace}`
- `purchases_total{workspace, launch}`
- `revenue_normalized_total{workspace, launch}`

## Métricas operacionais (técnicas)

- `edge_request_latency_seconds{route, method}` p50/p95/p99
- `edge_request_total{route, status_code}`
- `raw_events_processing_lag_seconds` (received → processed)
- `dispatch_succeeded_total{destination}`
- `dispatch_failed_total{destination, error_code}`
- `dispatch_skipped_total{destination, skip_reason}`
- `dlq_size{queue}` (alerta)
- `lead_token_validation_failures_total{reason}` (BR-EVENT-006)
- `event_time_clamps_total` (BR-EVENT-003)
- `webhook_signature_failures_total{platform}` (alerta)
- `audit_log_failures_total` (alerta — falha em recordAuditEntry é grave)
- `pii_decrypt_total{actor_role}` (auditoria)
- `cron_run_total{cron_name, status}`
- `cron_duration_seconds{cron_name}`

## Alertas

Alertas críticos (PagerDuty / similar):

| Alerta | Condição | Severidade |
|---|---|---|
| Edge p95 > 100ms | sustained 5min | warn |
| Edge p95 > 200ms | sustained 5min | critical |
| DLQ size > 100 | qualquer | critical |
| `dispatch_failed_total` > 5% rate | sustained 15min | warn |
| `webhook_signature_failures_total` > 0 | em 5min | warn (possível tampering) |
| `audit_log_failures_total` > 0 | qualquer | critical |
| Cron parado > 25h | sem execução | warn |
| `legacy_token_in_use_total` > 0 após janela | qualquer | info (lembrete operacional) |

Alertas warn em Slack; critical em PagerDuty.

## Dashboards

### Técnico (Metabase, role OPERATOR/ADMIN)

- **Latência por rota** — p50/p95/p99.
- **Saúde de filas** — lag, DLQ size, retry rate.
- **Saúde de dispatchers** — succeeded/failed/skipped por destino.
- **Auditoria de PII** — `pii_decrypt_total` ratio, `audit_log` recent.
- **Workspace health** — rate limit usage por workspace.

### Produto (Metabase, role MARKETER+)

Detalhe em FLOW-06.

### Privacy (Metabase, role PRIVACY)

- **SARs processados** — count, latência média, falhas.
- **Acessos a PII** — quem decryptou o quê.
- **Retention purge** — count purgado por categoria.
- **Consent rates** — granted/denied/unknown por finalidade.

## Saúde do Meta CAPI — view `v_meta_capi_health` (migration 0047)

View permanente para auditar EMQ (Event Match Quality) por evento Purchase/Lead/InitiateCheckout/Contact/CompleteRegistration sem decifrar PII. Cada linha projeta:

- **Sinais no próprio evento** (`ev_*`): `ev_fbc`, `ev_fbp`, `ev_ip`, `ev_ua`, `ev_geo` — booleans `IS NOT NULL` em `events.user_data`.
- **Sinais via lead** (`lead_*`): `lead_em`, `lead_ph`, `lead_fn`, `lead_ln` — booleans em `leads.{email_hash_external, phone_hash_external, fn_hash, ln_hash}`.
- **External ID**: `has_external_id` (= `events.visitor_id IS NOT NULL`).
- **Sinais via histórico** (`hist_*`): `hist_fbc`, `hist_fbp`, `hist_ip`, `hist_ua` — `EXISTS` de prior event do mesmo `lead_id` com cada sinal não-null.
- **Effective** (`eff_*`): `eff_fbc = ev_fbc OR hist_fbc`, etc. — projeta o que o dispatcher real efetivamente envia (espelhando `lookupHistoricalBrowserSignals` em `apps/edge/src/index.ts`).
- **Score 0..8**: soma de `eff_fbc + eff_fbp + eff_ip + eff_ua + lead_em + lead_ph + ev_geo + has_external_id`. 8 = advanced match top-tier.

### Sem filtro temporal — por design

A subquery `historical` faz `EXISTS` sem restrição `received_at < p.received_at`. Isso é **intencional** e alinha com o comportamento real do dispatcher: cookies `_fbc`/`_fbp` têm refresh cycle longo, e o `lookupHistoricalBrowserSignals` pega os 10 events mais recentes do lead independentemente da ordem cronológica vs o evento sendo dispatchado. Justificativa completa em [`docs/40-integrations/01-meta-capi.md`](../40-integrations/01-meta-capi.md#sem-filtro-temporal--por-design).

### Tolerância a rows legadas (T-13-013-FOLLOWUP)

Toda referência a `events.user_data` na view usa `(user_data #>> '{}')::jsonb` — re-cast idempotente que aceita tanto rows novas (jsonb-object) quanto rows pré-deploy `ed9a490d` (jsonb-string, legado do bug Hyperdrive driver). Sem isso, `user_data->>'fbc'` em row legada retornaria NULL silenciosamente e o score viria zerado falsamente.

### Uso típico

```sql
SELECT received_at, match_score, eff_fbc, eff_fbp, eff_ip, eff_ua,
       has_external_id, lead_em, lead_ph, ev_geo, amount, utm_source
  FROM v_meta_capi_health
 WHERE workspace_id = '74860330-a528-4951-bf49-90f0b5c72521'
   AND event_name = 'Purchase'
   AND received_at > now() - interval '24 hours'
 ORDER BY received_at DESC;
```

Validação de baseline pós-deploy `ba2fbe37` (2026-05-09): match_score subiu de 4-5/8 para **7/8** consistente em replays de 7 Purchases Guru anteriores. Gap remanescente é `ev_geo` quando `contact.address` da transação Guru vem vazio.

### Não é métrica em tempo real

A view recomputa em cada SELECT. Não há materialização nem rollup — chamar via Metabase ad-hoc ou cron diário, não em endpoint hot path.

## Doc-sync pending — métrica `dispatch_attempts.{request,response}_payload_sanitized`

Hoje todos os call sites em `apps/edge/src/lib/dispatch.ts` gravam `{}` literal nessas colunas. Para fechar o gap "o que efetivamente saiu pra Meta?" sem confiar apenas em `v_meta_capi_health`, próxima iteração deve estender `DispatchResult` com `request`/`response` opcionais e popular nos dispatchers (com IP redacted via `sanitizeDispatchPayload`). Tracking em `MEMORY.md §3 / DISPATCH-ATTEMPTS-PAYLOAD-EMPTY`.

## Saúde de integrações na home do Control Plane (ADR-046 follow-up, 2026-05-14)

Como complemento ao alerta externo via Meta Events Manager (que demorou ~16h para evidenciar o incident `2026-05-13` de Hyperdrive), a home do CP renderiza um snapshot operacional sempre visível ao logar:

- **`IntegrationsBanner`** — banner vermelho global no topo da home quando ≥ 1 provider inbound está em `state='down'`. Aponta para o card e sugere rodar `scripts/maintenance/webhook-smoke-test.sh` (INV-INFRA-001).
- **`IntegrationsHealthCard`** — semáforo por provider inbound (último recebido, count_1h, count_24h, state) + breakdown de outbound por destination (success_rate, state).

Backend em `GET /v1/dashboard/stats` (`apps/edge/src/routes/dashboard-stats.ts`). Classificação por **marker em `raw_events.payload`** que cada handler de webhook injeta:

| Provider | Marker no payload |
|---|---|
| Guru | `_guru_event_id` |
| OnProfit | `_onprofit_event_type` |
| SendFlow | `_provider = 'sendflow'` |
| Hotmart | `_hotmart_event_type` |
| Kiwify | `_kiwify_event_type` |
| Stripe | `_stripe_event_type` |

**Implicação para novos webhook adapters:** todo handler novo em `apps/edge/src/routes/webhooks/<provider>.ts` **deve** injetar marcador `_<provider>_event_type` (ou equivalente) em `raw_events.payload` antes de persistir — sem o marker, o provider some do dashboard de saúde e a próxima outage só será detectada externamente.

Thresholds (`state` ∈ `ok` / `warn` / `down`) e shape completo: ver `docs/30-contracts/05-api-server-actions.md` § `GET /v1/dashboard/stats`.

### Smoke test pós-deploy

`scripts/maintenance/webhook-smoke-test.sh` posta payload junk em cada endpoint inbound (guru / onprofit / sendflow) e falha em qualquer 5xx. 4xx = OK (validation funciona); 5xx = DB conn quebrada disfarçada.

INV-INFRA-001 (ADR-046): rodar após **rotação de senha Supabase**, **reconfig do Hyperdrive binding**, **`wrangler secret put DATABASE_URL`**, **codemod que toque DB conn ou bindings**, ou **deploy de rota webhook nova**. Deploy só é considerado completo após smoke test verde.

Validado em prática em 2026-05-14 (commit `149fbed`): smoke test capturaria o silencioso 500 que o incidente `2026-05-13` deixou rolar 16h.

## Tracing (opcional Fase 4+)

OpenTelemetry instrumentation se complexidade justificar. Pontos de instrumentação:
- HTTP request → Edge handler.
- Edge → DB query.
- Edge → KV read/write.
- Edge → Queue enqueue.
- Worker → Dispatcher → API externa.

CF Workers tem OTel collector experimental — avaliar maturidade na Fase 4.

## Logs específicos por evento

Padrão estruturado:
```json
{
  "level": "info",
  "msg": "event_accepted",
  "request_id": "uuid",
  "workspace_id": "uuid",
  "event_id": "evt_xyz",
  "event_name": "Lead",
  "schema_version": 1,
  "duplicate": false,
  "latency_ms": 23,
  "timestamp": "2026-05-01T20:01:10Z"
}
```

Eventos canônicos a logar:
- `event_accepted`, `event_duplicate`, `event_rejected`
- `lead_resolved`, `lead_merged`, `lead_erased`
- `dispatch_started`, `dispatch_succeeded`, `dispatch_failed`, `dispatch_skipped`
- `webhook_received`, `webhook_signature_invalid`
- `cron_started`, `cron_completed`, `cron_failed`
