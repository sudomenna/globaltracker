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
