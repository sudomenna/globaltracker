# FLOW-09 — Erasure por SAR (Subject Access Request)

## Gatilho
Lead solicita erasure (LGPD Art. 18 / GDPR Art. 17). PERSONA-PRIVACY-OFFICER recebe pedido e processa via Control Plane.

## Atores
PERSONA-PRIVACY-OFFICER ou OWNER, sistema (worker async).

## UC envolvidos
UC-009.

## MOD-* atravessados
`MOD-IDENTITY` (anonimização), `MOD-EVENT`, `MOD-ATTRIBUTION`, `MOD-AUDIT`, `MOD-DISPATCH` (token revoke).

## CONTRACT-* envolvidos
`CONTRACT-api-admin-leads-erase-v1`, `12.6` em api-server-actions.md.

## BRs aplicadas
BR-PRIVACY-005, BR-RBAC-005 (double-confirm), BR-AUDIT-003 (audit obrigatório).

## Fluxo principal

1. PERSONA-PRIVACY recebe pedido (email, formulário externo, etc.) com identificadores do lead (email, phone, ou `lead_public_id`).
2. PRIVACY autentica em Control Plane (Fase 4) ou usa API key com escopo `leads:erase`. (Em Fase 1-2, endpoint apenas via API.)
3. PRIVACY busca o lead via UI/API:
   - `GET /v1/admin/leads/search?email=foo@example.com` (admin endpoint).
   - Retorna `lead_public_id` + status atual.
4. PRIVACY confirma intenção de erase:
   - UI exige digitar `ERASE LEAD <lead_public_id>` (double-confirm — BR-RBAC-005).
   - API exige header `X-Confirm-Erase: ERASE LEAD <lead_public_id>` exato.
5. PRIVACY chama `DELETE /v1/admin/leads/<lead_public_id>` com header de confirmação.
6. Edge:
   - Valida auth + scope (`leads:erase`).
   - Valida role: `privacy` ou `admin` (BR-RBAC-005).
   - Valida header de confirm: parse e compare exato.
   - Se algo falha: 400 / 403 com error code claro.
   - Sucesso: enqueue `erase_job` em CF Queue. Insert em `audit_log` com `action='erase_sar', actor_id=privacy_user_id, entity_id=lead_public_id`.
   - Retorna 202 `{job_id, status: 'queued'}`.
7. Worker `erasure-worker` consome job:
   - Resolve `lead_public_id` → `lead_id` (canonical, seguindo cadeia merged se houver).
   - Inicia transaction.

8. Anonimização em ordem (transação):
   a. UPDATE `leads` SET `email_enc=NULL, phone_enc=NULL, name_enc=NULL, email_hash=NULL, phone_hash=NULL, external_id_hash=NULL, name_hash=NULL, status='erased'` WHERE id=L.
   b. UPDATE `lead_aliases` SET `status='revoked'` WHERE lead_id=L. (Mantém row para rastreio histórico, mas alias nunca mais resolve.)
   c. UPDATE `lead_tokens` SET `revoked_at=now()` WHERE lead_id=L. Nenhum token futuro será aceito.
   d. UPDATE `events` SET `user_data = user_data - 'em' - 'ph' - 'external_id_hash'`, `request_context = request_context - 'ip_hash' - 'ua_hash'` WHERE lead_id=L. Mantém event_name, event_time, custom_data.value/currency (analytics agregados preservados).
   e. UPDATE `lead_attribution` SET `fbclid=NULL, gclid=NULL, fbc=NULL, fbp=NULL` WHERE lead_id=L. Mantém source/medium/campaign (analytics agregados).
   f. UPDATE `link_clicks` SET `ip_hash=NULL, ua_hash=NULL, fbclid=NULL, gclid=NULL, fbc=NULL, fbp=NULL` WHERE row referência lead via association. (Link clicks anônimos não têm lead_id direto — mas associated via session.)
   g. DELETE `audience_snapshot_members` WHERE lead_id=L. Lead sai de audiences imediatamente — próximo sync remove em Meta/Google.
   h. INSERT `audit_log` com `action='erase_sar_completed', after={events_anonymized: count, attribution_anonymized: count}`.
9. Commit transaction.
10. Job → `succeeded`.
11. PRIVACY recebe notificação (email, dashboard) confirmando erasure completo.
12. Lead L, próxima vez que aparecer com mesmo email/phone:
    - `resolveLeadByAliases` não encontra match (aliases revoked).
    - Cria lead novo (sem ligação ao L erased).

## Fluxos alternativos

### A1 — Lead já erased (idempotência)

7'. Worker descobre `lead.status='erased'` antes de iniciar:
   - Worker registra `audit_log` com `action='erase_sar_skipped_already_erased'`.
   - Job → `succeeded`.
   - Comportamento idempotente — chamar `DELETE` 2× é OK.

### A2 — Lead em cadeia merged

7''. `lead_public_id` resolve para lead `merged`:
   - Worker segue `merged_into_lead_id` até `active` ou `erased`.
   - Aplica erasure no canonical efetivo.
   - Outros leads na cadeia já estão `merged` → suficiente atualizar canonical.

### A3 — Erasure em massa (Fase 4+)

PRIVACY pode requisitar erasure de múltiplos leads (ex.: workspace solicita erasure de todos leads inativos > 36 meses):
- Endpoint `/v1/admin/leads/erase-batch` com lista.
- Cada lead processed individualmente.
- Métrica de progresso visível.

### A4 — Erro durante anonimização

8'. UPDATE em events falha (timeout DB, lock contention):
   - Transaction roll back.
   - Job → `retrying` com backoff.
   - Após 5 attempts → `dead_letter`.
   - Alerta para PRIVACY + OPERATOR.
   - Lead permanece `active` até retry success.

### A5 — Performance — lead com 100k+ events

8d'. UPDATE de 100k events pode demorar. Mitigação:
   - Particionar UPDATE em batches de 10k.
   - Ou usar background materialized: marcar lead como `pending_erase`; cron processa em background.
   - SLA: < 60s para lead com 100k events. Para > 100k: SLA estendido, monitor.

### A6 — Erasure de lead em audience ativa

g'. Lead estava em audience snapshot ativo:
   - Snapshot member removido.
   - Próximo cron de audience sync detecta diff (lead em removals).
   - Sync envia DELETE a Meta/Google.
   - Lead deixa de estar em remarketing.

## Pós-condições

- `leads.status='erased'`, PII zerada.
- `lead_aliases` revogados.
- `lead_tokens` revogados (cookies do lead deixam de funcionar).
- `events`, `attribution`, `link_clicks` anonimizados em campos PII.
- `audience_snapshot_members` removidos.
- `audit_log` com entry detalhado.

## TE-* emitidos

- TE-LEAD-ERASED-v1
- TE-LEAD-TOKEN-REVOKED-v1 (cada token)
- TE-AUDIENCE-* na próxima sync (remoção)

## Casos de teste E2E

1. **Happy path** SAR: lead com 1k events erase em < 5s, dados anonimizados verificados.
2. **Idempotência**: chamar DELETE 2× → 2º retorna 200 sem reprocessar.
3. **Authz**: marketer chama → 403; privacy chama → 202.
4. **Double-confirm**: sem header X-Confirm-Erase → 400.
5. **Cadeia merged**: erase em lead merged segue ponteiro até canonical.
6. **Audit log**: após erase, `audit_log where action='erase_sar'` presente com `before/after`.
7. **Revogação efetiva**: após erase, `__ftk` antigo desse lead falha em `/v1/events`.
