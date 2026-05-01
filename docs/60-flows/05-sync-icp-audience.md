# FLOW-05 — Sincronizar público ICP

## Gatilho
Cron diário ou trigger manual via UI.

## Atores
Sistema (cron + worker); MARKETER consulta resultado.

## UC envolvidos
UC-005.

## MOD-* atravessados
`MOD-AUDIENCE`, `MOD-IDENTITY`, `MOD-DISPATCH`.

## CONTRACT-* envolvidos
`40-integrations/02-meta-custom-audiences.md`, `40-integrations/05-google-customer-match.md`.

## BRs aplicadas
BR-AUDIENCE-001 a 004, BR-CONSENT-003.

## Fluxo principal

1. Cron `audience-sync.ts` roda diariamente. Para cada workspace, lista audiences com `status='active'`.
2. Para audience A1 (`destination_strategy='meta_custom_audience'`, `consent_policy.require_customer_match=true`):
   - Chama `evaluateAudience(A1)`:
     - Avalia `query_definition` (DSL): `all: [stage='registered', is_icp=true, not_stage='purchased']`.
     - SQL gerado: leads com `lead_stages.stage='registered'` AND `lead_icp_scores.is_icp=true` AND NOT EXISTS lead_stages.stage='purchased'.
     - Filtra por `consent_customer_match='granted'` (BR-AUDIENCE-004).
     - Filtra `lead.status='active'` (não `merged` nem `erased`).
     - Resultado: `member_count=234`, `members=[lead_id_1, ..., lead_id_234]`.
3. Calcula `snapshot_hash = sha256(sorted(members).join(','))`.
4. Compara com snapshot anterior (`audience_snapshots` mais recente):
   - Se `snapshot_hash` igual → noop, registra TE-AUDIENCE-SNAPSHOT-NOOP, retorna.
   - Se diferente: cria novo `audience_snapshots` row + insert em `audience_snapshot_members`.
5. `createSyncJob(A1, snapshot_id, prev_snapshot_id)`:
   - Calcula diff via SET difference: `additions = members(T) - members(T-1)`, `removals = members(T-1) - members(T)`.
   - `audience_sync_jobs.planned_additions=12, planned_removals=3`.
6. Worker `audience-sync-meta` recebe job. Adquire lock por `(audience_id, audience_resource_id)` (BR-AUDIENCE-002).
7. Worker monta payload Meta:
   - Para cada lead em additions: `lookup leads.email_hash, phone_hash` (já hashados normalizados).
   - Batch de 10k entries.
8. Worker chama `POST /<meta_audience_id>/users` com batch additions e separadamente `DELETE` para removals.
9. Meta retorna `200 { num_received: 12, num_invalid_entries: 0 }`.
10. Worker atualiza `audience_sync_jobs.status='succeeded'`, `sent_additions=12`, `sent_removals=3`. Libera lock.
11. Snapshot anterior → `retention_status='archived'` (cron de retenção purga após 30d se ≥ 2 mais recentes existem).

## Fluxos alternativos

### A1 — Audience com `disabled_not_eligible`

2'. `audience.destination_strategy='disabled_not_eligible'` (Google sem credencial):
   - `evaluateAudience` ainda roda (gera snapshot para histórico).
   - `createSyncJob` skip — não cria job; registra `audience_sync_jobs.status='succeeded'` com `sent_additions=0, sent_removals=0` e nota `eligibility_reason='not_eligible'`.
   - Sem chamada externa.

### A2 — Customer Match Google retorna `CUSTOMER_NOT_ALLOWLISTED`

8'. Workspace tinha `destination_strategy='google_ads_api_allowlisted'` mas Google retorna error:
   - `audience_sync_jobs.status='failed'`, `error_code='CUSTOMER_NOT_ALLOWLISTED'`.
   - Auto-demote: `audience.destination_strategy='disabled_not_eligible'` + flag `auto_demoted_at=now()`.
   - Métrica alerta MARKETER em dashboard técnico.
   - Próximo sync segue A1.

### A3 — Lock contestado (sync paralelo)

6'. Outro worker já tem lock (sync simultâneo da mesma audience):
   - Worker B abandona sem processar; job permanece pending.
   - Próximo cron retoma.

### A4 — Snapshot sem mudança (noop)

4'. `snapshot_hash` igual ao anterior:
   - Não cria novo snapshot.
   - Não cria sync job.
   - Métrica `audience_snapshot_noop_total` incrementa.
   - Nada enviado a Meta/Google.

### A5 — Lead em snapshot mas erased após

Cenário: snapshot gerado em T0; em T+1d, lead L2 entra em erased.
- Próxima geração de snapshot exclui L2 (filtro `lead.status='active'`).
- Diff vs T0 inclui L2 em `removals`.
- Sync envia DELETE para Meta com hash de L2.

## Pós-condições

- `audience_snapshots` row nova (com members).
- `audience_sync_jobs` row registra resultado.
- Audience platform-side reflete diff.
- Métricas atualizadas.

## TE-* emitidos

- TE-AUDIENCE-SNAPSHOT-GENERATED-v1
- TE-AUDIENCE-SYNC-SUCCEEDED-v1 ou TE-AUDIENCE-SYNC-FAILED-v1

## Casos de teste E2E

1. **Happy path**: snapshot novo → diff → sync Meta → succeeded.
2. **Noop**: snapshot igual → nada enviado.
3. **Customer Match auto-demote**: Google retorna allowlist error → strategy muda para `disabled_not_eligible`.
4. **Lock contention**: 2 cron simultâneos → apenas 1 processa.
5. **Consent revogado entre snapshots**: lead presente em T-1 com consent denied em T → vai para removals.
