# Sprint 3 — Meta CAPI v1 + webhook Digital Manager Guru

## Duração estimada
2-3 semanas.

## Objetivo
Dispatcher Meta CAPI funcional com enriquecimento server-side; adapter Digital Manager Guru; FLOW-03 e FLOW-04 verdes.

## Pré-requisitos
- Sprint 2 completo.

## Critério de aceite global

- [ ] Meta CAPI dispatcher: lookup em leads, retry 429/5xx, DLQ após 5 attempts, idempotency_key.
- [ ] Adapter Digital Manager Guru: validação de `api_token`, mapper transaction + subscription, fixtures.
- [ ] FLOW-03 (Meta CAPI dedup) e FLOW-04 (Purchase via webhook) E2E verdes.
- [ ] Métricas operacionais (`dispatch_health_view`) populadas.
- [ ] Smoke em produção (com pixel/webhook test mode).

## Fora de escopo (Sprint 9)

- Adapter Hotmart
- Adapter Kiwify
- Adapter Stripe

---

## Decisões de arquitetura

- **Meta CAPI token (Sprint 3):** env var global (`META_CAPI_TOKEN`). Token por-workspace planejado para Fase 2 — `workspace_integrations` já é extensível para receber essa coluna.
- **`pixel_id`:** por-launch, em `launches.config.tracking.meta.pixel_id`.
- **`workspace_integrations`:** tabela one-to-one com `workspaces`, colunas nullable por provider. Sprint 3 preenche `guru_api_token`. Novos providers adicionam colunas em sprints futuros.
- **`/v1/webhook/guru`:** rota server-to-server — sem `authPublicToken` nem `corsMiddleware` (diferente das rotas de browser).
- **CF Queue handler:** `index.ts` exporta `{ fetch, queue }` no default export; T-3-007 adiciona o handler `queue`.

---

## Ondas de execução

### Pré-onda (serial) — SYNC-PENDING Sprint 2 ✅
| Agente | Tarefa |
|---|---|
| `globaltracker-docs-sync` | `docs/20-domain/13-mod-tracker.md §7`: `window.__funil_event_id` + sessionStorage TTL 5min |
| `globaltracker-docs-sync` | `docs/30-contracts/07-module-interfaces.md`: consent.ts usa `workspace_id` explícito |

### Onda 0 (serial — schema) ✅
| Agente | Tarefa | Arquivo |
|---|---|---|
| `globaltracker-schema-author` | Tabela `workspace_integrations` + migration 0021 | `packages/db/src/schema/workspace_integrations.ts` |

### Onda 1 (paralela — 3 agentes)
| T-ID | Agente | Ownership |
|---|---|---|
| T-3-001/002/003 | `globaltracker-dispatcher-author` | `apps/edge/src/dispatchers/meta-capi/{mapper,client,eligibility,index}.ts` |
| T-3-004 | `globaltracker-webhook-author` | `apps/edge/src/routes/webhooks/guru.ts` + `apps/edge/src/integrations/guru/mapper.ts` |
| T-3-008 | `globaltracker-domain-author` | `apps/edge/src/lib/dispatch.ts` |

### Onda 2 (serial — wiring)
| T-ID | Agente | Ownership |
|---|---|---|
| T-3-007 | `globaltracker-edge-author` | `apps/edge/src/index.ts` (queue handler + `/v1/webhook/guru` route mount) |

### Onda 3 (paralela — fechar sprint)
| T-ID | Agente | Ownership |
|---|---|---|
| T-3-009 | `globaltracker-test-author` | `tests/e2e/flow-03-meta-capi-dedup.test.ts` + `tests/e2e/flow-04-purchase-webhook.test.ts` |
| — | `globaltracker-docs-sync` | Sync doc canônica sprint 3 |

---

## T-IDs detalhadas

### T-3-001 — Meta CAPI mapper
**Tipo:** dispatcher
**Ownership:** `apps/edge/src/dispatchers/meta-capi/mapper.ts`
**Critério:** `mapEventToMetaPayload(event, lead, ctx)` pura + testável; cobre PageView, Lead, Purchase; aplica hash SHA-256 em `em`/`ph`; inclui `fbc`, `fbp`, `client_ip_address`, `client_user_agent`; `custom_data` para eventos monetários.

### T-3-002 — Meta CAPI client
**Tipo:** dispatcher
**Ownership:** `apps/edge/src/dispatchers/meta-capi/client.ts`
**Critério:** `sendToMetaCapi(payload, config)` com `fetch` injetável para testes; interpreta 2xx/429/4xx/5xx; retorna `Result<MetaCapiResponse, MetaCapiError>` tipado.

### T-3-003 — Meta CAPI eligibility
**Tipo:** dispatcher
**Ownership:** `apps/edge/src/dispatchers/meta-capi/eligibility.ts`
**Critério:** `checkEligibility(job, lead, launchConfig)` — verifica consent `ad_user_data=granted`; pelo menos um de `em/ph/fbc/fbp/external_id_hash`; `pixel_id` configurado em `launches.config.tracking.meta`; retorna `{ eligible: true } | { eligible: false; reason: SkipReason }`.

### T-3-004 — Webhook adapter Digital Manager Guru
**Tipo:** webhook
**Ownership:** `apps/edge/src/routes/webhooks/guru.ts` + `apps/edge/src/integrations/guru/mapper.ts`
**Critério:** `POST /v1/webhook/guru`; autentica por `api_token` no body via lookup em `workspace_integrations.guru_api_token` (timing-safe); normaliza `transaction` (approved/refunded/chargedback/canceled) e `subscription` (active/canceled); ignora `eticket` com 202; idempotência via `sha256("guru:" + webhook_type + ":" + id + ":" + status)[:32]`; persiste em `raw_events`; envia para `QUEUE_EVENTS`.

### T-3-007 — Dispatch worker (CF Queue consumer)
**Tipo:** edge
**Ownership:** `apps/edge/src/index.ts`
**Critério:** handler `queue` exportado; consome fila `gt-dispatch`; faz lock atômico `pending→processing` (BR-DISPATCH-002); chama dispatcher correto pelo `destination`; atualiza status do job; registra `dispatch_attempt`; suporta `meta_capi` neste sprint.

### T-3-008 — Backoff + DLQ
**Tipo:** domain
**Ownership:** `apps/edge/src/lib/dispatch.ts`
**Critério:** `createDispatchJobs(event, ctx)`, `processDispatchJob(job_id, ctx)`, `markDeadLetter(job_id, reason, ctx)`, `requeueDeadLetter(job_id, ctx)` — todas as funções conforme `docs/20-domain/08-mod-dispatch.md §10`; `computeBackoff(attempt)` com jitter ±20% (INV-DISPATCH-007); `computeIdempotencyKey()` conforme ADR-013 (INV-DISPATCH-002).

### T-3-009 — E2E FLOW-03 + FLOW-04
**Tipo:** test
**Ownership:** `tests/e2e/`
**Critério:** FLOW-03 (`docs/60-flows/03-send-lead-to-meta-capi-with-dedup.md`) verde; FLOW-04 (`docs/60-flows/04-register-purchase-via-webhook.md`) verde.
