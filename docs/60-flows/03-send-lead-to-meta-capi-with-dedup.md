# FLOW-03 — Enviar Lead para Meta CAPI com deduplicação

## Gatilho
Lead event aceito pelo sistema; dispatch job criado para Meta CAPI.

## Atores
Sistema (worker async); MARKETER consulta resultado.

## UC envolvidos
UC-003.

## MOD-* atravessados
`MOD-EVENT`, `MOD-DISPATCH`, `MOD-IDENTITY` (lookup `leads` para enriquecer).

## CONTRACT-* envolvidos
`40-integrations/01-meta-capi.md`.

## BRs aplicadas
BR-DISPATCH-001 a 005, BR-CONSENT-003.

## Fluxo principal

1. Ingestion processor cria `dispatch_jobs` row para `destination='meta_capi'`, `destination_resource_id=pixel_id`, `destination_subresource=pixel_id` (mesmo valor — ver ADR-013), `idempotency_key` derivada.
2. Job enfileirado em CF Queue.
3. Worker `meta-capi-dispatcher` recebe job, faz lock atômico (`status: pending → processing`).
4. Eligibility check:
   - `consent_snapshot.ad_user_data` = `granted` ✓
   - `events.lead_id` populado → faz `SELECT email_hash, phone_hash, fbc, fbp FROM leads WHERE id=L`.
   - Pixel ID configurado no launch ✓
5. Mapper monta payload Meta:
   ```json
   {
     "event_name": "Lead",
     "event_time": <unix>,
     "event_id": "<events.event_id>",
     "user_data": {
       "em": "<email_hash>",
       "ph": "<phone_hash>",
       "fbc": "<fbc>",
       "fbp": "<fbp>",
       "client_ip_address": "<transient>",
       "client_user_agent": "<transient>"
     },
     "custom_data": { "value": ..., "currency": ... }
   }
   ```
6. Worker chama `POST graph.facebook.com/.../events` com `Authorization: Bearer <token>`.
7. Meta retorna 200; worker atualiza `dispatch_job.status='succeeded'` + cria `dispatch_attempt` row com response sanitized.
8. Pixel browser também disparou Lead com mesmo `event_id`. Meta dedupa internamente em janela de 48h.

## Fluxos alternativos

### A1 — Erro 429 (rate limit)

7'. Meta retorna 429:
   - `dispatch_attempt.status='retryable_failure'`.
   - Job → `retrying` com `next_attempt_at = now() + computeBackoff(attempt)`.
   - CF Queue recebe re-enqueue com delay.
   - attempt 2..5 conforme política (BR-DISPATCH-003).
   - Após attempt 5 sem sucesso → `dead_letter`.

### A2 — Erro 400 permanente

7''. Meta retorna 400 `invalid_pixel_id`:
   - `dispatch_job.status='failed'` imediato (sem retry).
   - Métrica `meta_capi_dispatch_failed_total{error_code='invalid_pixel_id'}` alerta.
   - OPERATOR investiga config do Pixel.

### A3 — Consent denied (pre-dispatch)

4'. `consent_snapshot.ad_user_data='denied'`:
   - Eligibility check falha.
   - Job → `status='skipped'`, `skip_reason='consent_denied:ad_user_data'`.
   - Sem chamada à Meta API.

### A4 — Sem `user_data` suficiente (PageView anônimo)

4''. PageView sem `lead_id` (visitante anônimo, sem `__ftk`):
   - Eligibility check para PageView é mais permissiva — basta `fbc`/`fbp`/IP/UA (sem PII).
   - Mapper monta payload mínimo; dispatch ocorre normalmente.
   - Lead remarketing audience preenchida no lado da Meta.

### A5 — Mensagem duplicada na queue

3'. CF Queue at-least-once entrega 2× para mesmo job:
   - Worker A faz UPDATE atômico → 1 row updated; processa.
   - Worker B faz UPDATE → 0 rows (já em processing); abandona.
   - Apenas 1 chamada à Meta API (BR-DISPATCH-002).

## Pós-condições

- `dispatch_jobs.status` em `succeeded`/`failed`/`skipped`/`dead_letter`.
- `dispatch_attempts` rows registram histórico.
- Meta Pixel/CAPI tem evento dedup'd com `event_id` consistente.

## TE-* emitidos

- TE-DISPATCH-CREATED-v1
- TE-DISPATCH-SUCCEEDED-v1 ou TE-DISPATCH-FAILED-v1 ou TE-DISPATCH-SKIPPED-v1 ou TE-DISPATCH-DEAD-LETTER-v1

## Casos de teste E2E sugeridos

1. **Happy path** com lead identificado, payload enriquecido server-side, Meta retorna 200.
2. **Retry 429**: Meta retorna 429 → backoff → eventual sucesso na attempt 2.
3. **Permanent failure**: Meta retorna 400 invalid_pixel → failed sem retry.
4. **Consent denied**: skipped sem chamada externa.
5. **Idempotência queue**: msg duplicada na queue → 1 call.
