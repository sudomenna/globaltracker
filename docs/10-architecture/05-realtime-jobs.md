# 05 — Realtime, jobs e idempotência

## Mapa de subsistemas

(Mesma tabela em [`20-domain/README.md` §6.1](../20-domain/README.md))

| Subsistema | Modo | Tecnologia | Fase |
|---|---|---|---|
| Ingestão `/v1/*` | sync | CF Worker | 1 |
| Ingestion processor (raw → normalized) | async | CF Queue consumer | 1-2 |
| Dispatch jobs (Meta/Google/GA4) | async | CF Queue consumer | 2 |
| Cost ingestor | scheduled diário | CF Cron Trigger | 3 |
| FX rates fetch | scheduled diário | CF Cron Trigger | 3 |
| Audience sync (eval+diff+dispatch) | scheduled+queue | CF Cron + CF Queue | 3 |
| Retention purge | scheduled diário | CF Cron Trigger | 1 (audit) / 2 (events/raw_events) |
| Page token rotation reminders | scheduled diário | CF Cron Trigger | 4 |
| Orchestrator workflows | event-driven | Trigger.dev | 5 |

## Cloudflare Queues

- Garantia: at-least-once delivery (RNF-004).
- Lock atômico no consumer antes de side effect (BR-DISPATCH-002).
- Backoff: CF Queues controla retry; consumidor decide se sucesso ou falha via response.
- DLQ: configurada na queue (CF nativa). Após `max_attempts`, mensagem vai para DLQ queue.

Queues utilizadas:

| Queue | Producer | Consumer | Mensagens |
|---|---|---|---|
| `QUEUE_RAW_EVENTS` | Edge `/v1/events` | `apps/edge/src/lib/raw-events-processor.ts` | `{raw_event_id}` |
| `QUEUE_DISPATCH` | Ingestion processor + dispatchers | `apps/edge/src/dispatchers/*` workers | `{dispatch_job_id, destination}` |
| `QUEUE_AUDIENCE_SYNC` | Audience cron | `apps/edge/src/dispatchers/audience-sync/*` | `{audience_sync_job_id}` |
| `QUEUE_DLQ` | (auto pela CF) | manual reprocessing | mensagens originais |

## CF Cron Triggers

Configurados em `apps/edge/wrangler.toml`:

```toml
[triggers]
crons = [
  "0 17 * * *",   # FX rates fetch (UTC 17:00)
  "0 2 * * *",    # daily_funnel_rollup refresh (UTC 02:00)
  "30 2 * * *",   # ad_performance_rollup refresh
  "0 3 * * *",    # audience sync evaluation
  "0 4 * * *",    # cost ingestor
  "0 5 * * *",    # retention purge (audit_log, events particioning, raw_events)
  "0 * * * *",    # page_tokens rotation status check (hourly)
]
```

Handler em `apps/edge/src/index.ts` `scheduled()` despacha por cron expression.

## Idempotência — checklist

| Subsistema | Como garante | Onde está |
|---|---|---|
| `/v1/events` | KV replay protection (TTL 7d, **best-effort**) + `unique (workspace_id, event_id, received_at)` em events particionada | BR-EVENT-002, BR-EVENT-004, ADR-040 |
| `/v1/lead` | Mesma; payload com mesmo event_id retorna idempotent | mesmo |
| `/v1/webhook/*` | `event_id = sha256(platform:platform_event_id)` + unique constraint | BR-WEBHOOK-002 |
| Ingestion processor | At-least-once delivery; `events` unique constraint absorve duplicata | BR-EVENT-002 |
| Dispatch jobs | `idempotency_key` único; lock atômico antes de processar | BR-DISPATCH-001, BR-DISPATCH-002 |
| Audience sync | `audience_sync_jobs.snapshot_id`; lock por audience_id | BR-AUDIENCE-002 |
| Cost ingestor | Unique `(workspace, platform, account, ...granularity, date)`; upsert idempotente | BR-COST-001 |
| Retention purge | Idempotente por design — DELETE WHERE ts < N | — |

## Cloudflare KV — uso e padrão best-effort (ADR-040)

KV no edge worker é usado para 5 finalidades, **todas best-effort por design** (falha de write NÃO pode 500ar a request — defesa primária mora em Postgres):

| Call site | Path | Função | Defesa primária |
|---|---|---|---|
| `apps/edge/src/lib/replay-protection.ts` | `markSeen` (write), `isReplay` (read) | Fast-path dedup de events | `unique (workspace_id, event_id, received_at)` em `events` |
| `apps/edge/src/lib/idempotency.ts` | `checkAndSet` | Webhook idempotency check | `idempotency_key` UNIQUE em `raw_events` |
| `apps/edge/src/middleware/rate-limit.ts` | counter increment | Rate limit sliding window | (best-effort puro — perda transiente aceitável) |
| `apps/edge/src/routes/config.ts` | cache `/v1/config` response | Reduz round-trip ao DB | DB SELECT como fallback (cold start) |
| `apps/edge/src/integrations/fx-rates/cache.ts` | FX rates cache | Reduz fetch externo de provider | Provider re-fetch como fallback |

**Convenção obrigatória para todo `kv.put()` novo:**
1. `try/catch` em torno do put. Retorna `boolean` (ou `Result<error>` se distinguir falhas).
2. Caller loga `safeLog('warn', { event: '<nome>_kv_write_failed', request_id, workspace_id })`.
3. Sem retry inline. KV é storage não-crítico.

Histórico do incidente que motivou ADR-040: 2026-05-09 ~11:00 UTC, KV daily quota free tier (1.000 writes/dia) bateu o teto. `markSeen` lançava sem catch → `/v1/events` virava 500 → tracker.js silenciava (INV-TRACKER-007) → ZERO PageView/Lead/click no DB de 10:42 a 16:58 UTC. Resolvido com upgrade para Workers Paid + try/catch em `markSeen` (commit `85777ec`).

**Tech-debt / otimizações futuras** (registradas em `MEMORY.md §3`): config cache em memória por instance, rate-limit migrado para Durable Objects, skip `markSeen` quando idempotency check primário já marcou duplicata.

## DLQ (Dead Letter Queue)

DLQ por queue. Após `max_attempts=5` (configurável por queue), mensagem move para DLQ.

Reprocessamento manual:
- Endpoint admin `/v1/admin/dlq/reprocess?queue=<name>&job_id=<id>` (Fase 4).
- Audit log com `action='reprocess_dlq'`.
- Reseta `attempt_count`, status retorna a `pending`.

Métricas:
- `dlq_size{queue}` — alerta se > threshold.
- `dlq_reprocessed_total{queue}` — operação manual.

## Backoff strategy

```ts
function computeBackoff(attempt: number): number {
  const base = Math.pow(2, attempt); // 1, 2, 4, 8, 16 segundos
  const jitter = (Math.random() * 0.4) - 0.2; // ±20%
  return Math.max(1, Math.floor(base * (1 + jitter)));
}
```

Aplicação:
- Attempt 1 → ~1s delay.
- Attempt 5 → ~16s delay (cumulativo ~31s).
- Após attempt 5 → DLQ.

## Observabilidade de filas

Métricas obrigatórias:
- `queue_messages_enqueued_total{queue}`
- `queue_messages_consumed_total{queue, status}`
- `queue_consumer_latency_seconds{queue}` p50/p95/p99
- `queue_lag_seconds{queue}` — diferença entre enqueue e consume
- `dlq_size{queue}`

Dashboard técnico em Metabase consume `dispatch_health_view` para visualização.

## Trigger.dev (Fase 5)

Workflows complexos com aprovação humana — provisioning de campanhas Meta/Google, deploy de LP, setup de tracking automatizado. Aprovação humana via UI Trigger.dev ou Control Plane.

Não compete com CF Queues — Trigger.dev é para fluxos longos com state machine; CF Queues é para tasks curtas idempotentes.
