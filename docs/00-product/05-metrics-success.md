# 05 — Métricas de sucesso

Métricas de produto e operacionais por fase. Métricas de produto reais começam na Fase 2 (Fase 1 entrega fundação técnica, sem produto operável).

## Convenções

- **Meta inicial:** valor desejado para considerar a fase concluída.
- **Como medir:** fonte de verdade da métrica.
- **Owner:** quem monitora durante operação.

---

## Fase 1 — Métricas técnicas

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| Cobertura de testes em `apps/edge/src/lib/` | ≥ 90% | Vitest coverage report em CI | OPERATOR |
| Cobertura de testes em `packages/db/` | ≥ 80% | Vitest coverage report | OPERATOR |
| Migrations versionadas e reversíveis | 100% | Drizzle CI check | OPERATOR |
| Endpoints documentados em Zod | 100% | Schema diff vs `30-contracts/` | OPERATOR |
| Smoke test do Worker em CI | passa em < 30s | GitHub Actions | OPERATOR |
| `/v1/events` p95 no fast accept | < 50ms | Wrangler observability + load test local | OPERATOR |
| Logs sanitizados (zero PII) | 0 occorrências | grep test em fixtures + integration test | OPERATOR + PRIVACY |

## Fase 2 — Métricas de tracking confiável

### Saúde do pipeline

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| Eventos aceitos pelo Edge | 100% retornam 202 | `dispatch_health_view` | OPERATOR |
| `raw_events` processed within 5min | ≥ 99% | Diff `received_at` vs `processed_at` | OPERATOR |
| `dispatch_jobs` em estado `pending` por > 24h | 0 | Métrica + alerta | OPERATOR |
| Taxa de sucesso Meta CAPI dispatch | ≥ 95% | `dispatch_attempts.status='succeeded' / total` | MARKETER |
| Taxa de retry exitosa após 5xx Meta | ≥ 90% | Dispatcher logs | OPERATOR |
| `lead_token_validation_failures` ratio | < 1% (excluindo expirações naturais) | Métrica edge | OPERATOR |
| `event_time_clamps` ratio | < 5% | Métrica edge | OPERATOR |

### Identidade

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| Retornantes reconhecidos via `__ftk` | ≥ 60% dos leads que retornam em < 60d (smoke E2E) | Test fixture + métrica `__ftk` valid presence | MARKETER |
| Lead merges executados sem erro | 100% | `lead_merges` count vs erros | OPERATOR |
| Dispatchs Meta CAPI com `user_data` enriquecido server-side | ≥ 80% dos eventos com `lead_id` resolvido | Logs do dispatcher | MARKETER |

### Webhooks

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| Webhook signature failures Stripe | 0 (em produção real) | Métrica adapter + alerta | OPERATOR |
| Webhook duplicado idempotente (mesmo `event_id` interno) | 100% retornam idempotente sem duplicar | Integration test + métrica | OPERATOR |
| Tempo médio webhook→evento normalizado | < 30s p95 | Diff `received_at` (raw_events) vs `processed_at` (events) | OPERATOR |

## Fase 3 — Métricas de produto e analytics

### Atribuição

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| Leads com first-touch atribuído | ≥ 95% | Count `lead_attribution where touch_type='first'` / total leads | MARKETER |
| Leads com last-touch atribuído | ≥ 95% | Count `lead_attribution where touch_type='last'` | MARKETER |
| Eventos com `account_id` + `campaign_id` + `ad_id` granular | ≥ 80% (depende do operador configurar macros) | Eventos com campos não-nulos | MARKETER |
| Lead retroativamente ligado a PageView anônimo | ≥ 50% (depende de retorno same-device) | `events` com `lead_id` populado retroativamente | MARKETER |

### Custos e ROAS

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| `ad_spend_daily` ingestion failures | 0 dias com dados faltantes | Métrica cron | OPERATOR |
| FX normalization aplicada | 100% dos `ad_spend_daily` | `where spend_cents_normalized IS NOT NULL` | OPERATOR |
| Dashboard CPL/CPA com valores não-nulos | ≥ 90% após 7 dias de tracking | Metabase | MARKETER |
| ROAS calculado coerente (cross-currency) | Diferença < 1% vs fonte oficial | Spot check semanal | MARKETER |

### Audiences

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| Audience sync success rate | ≥ 95% para audiences `active` | `audience_sync_jobs.status='succeeded'/total` | MARKETER |
| Match rate Meta Custom Audience | ≥ 60% (varia por qualidade da lista) | Resposta da Meta API | MARKETER |
| Customer Match Google sync (Data Manager API) | ≥ 90% após estratégia configurada | API response | MARKETER |
| Audiences com `disabled_not_eligible` chamando Google API | 0 (validação de pré-condição) | Logs do dispatcher | OPERATOR |

## Fase 4+ — Métricas de UI e operação

(A definir quando Fase 4 for planejada em detalhe.)

---

## Métricas de privacidade (todas as fases)

| Métrica | Meta inicial | Como medir | Owner |
|---|---|---|---|
| PII em logs estruturados | 0 ocorrências | Grep test contra padrões + integration test | PRIVACY |
| SAR processados em SLA (≤ 30 dias) | 100% | `audit_log` action='erase_sar' | PRIVACY |
| Tempo médio de processamento SAR | < 60s para lead com até 100k eventos | Métrica do job de anonimização | PRIVACY |
| Acessos a PII em claro (Privacy/Owner) | Logado em 100% dos casos | `audit_log` action='read_pii_decrypted' | PRIVACY |
| Consents capturados com `policy_version` | 100% | `lead_consents.policy_version IS NOT NULL` | PRIVACY |
| Dispatch bloqueado por consent denied | reportado em `dispatch_jobs.skip_reason='consent_denied'` | Métrica + relatório mensal | PRIVACY |

---

## Métricas de saúde de tenant

Aplicáveis a partir da Fase 2 (multi-tenant operacional na Fase 4).

| Métrica | Meta inicial | Como medir |
|---|---|---|
| Workspace consumindo > 80% da quota de rate limit | alerta para Operator | Métrica edge agregada |
| Workspace com falhas de dispatch > 5% | alerta + investigação | `dispatch_health_view` por workspace |
| Page tokens em status `rotating` por > janela de overlap | alerta + lembrete ao Marketer | Métrica `legacy_token_in_use` |

---

## Anti-métricas (o que **não** usar como sucesso)

- **Volume bruto de eventos.** Volume alto pode indicar bug (loop, duplicação) tanto quanto sucesso. Sempre monitorar **junto** com `events_rejected` ratio.
- **Cobertura de testes 100%.** 90% bem distribuído > 100% com testes vazios. Foco em cobertura de BR e contratos.
- **Latência média.** Sempre medir p95/p99. Média esconde caudas longas.
- **Match rate Customer Match isolado.** Match rate baixo pode ser bom (audience pequena/segmentada) ou ruim (PII mal hashada). Contextualizar com audience size + consent rate.

---

## Cadence de revisão

| Cadência | O que revisar | Quem |
|---|---|---|
| Diária (operação ativa) | Latência ingestion, dispatch failures, DLQ size, webhook signature failures | OPERATOR |
| Semanal | CPL/CPA por anúncio, audience sync, ROAS, freshness de rollups | MARKETER |
| Mensal | Privacidade (SARs, retenção, consent), drift de match rate, anti-métricas | PRIVACY + MARKETER |
| Trimestral | OBJ-* da fase atual; trade-offs de scope; ADRs novos | OWNER + ADMIN |
