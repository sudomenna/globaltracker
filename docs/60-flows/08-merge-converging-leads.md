# FLOW-08 — Merge de leads convergentes

## Gatilho
Identify request com identificadores que matcham 2+ leads ativos.

## Atores
PERSONA-LEAD (ação que dispara), sistema.

## UC envolvidos
UC-008.

## MOD-* atravessados
`MOD-IDENTITY` (resolver + merge), `MOD-EVENT`, `MOD-ATTRIBUTION`, `MOD-FUNNEL`, `MOD-AUDIT`.

## CONTRACT-* envolvidos
`CONTRACT-api-lead-v1`, `30-contracts/07-module-interfaces.md` (`resolveLeadByAliases`).

## BRs aplicadas
BR-IDENTITY-001 a 004, BR-RBAC-006 (audit em mutações).

## Cenário

- T0: Lead A se cadastra em LP X com email-only `foo@example.com`. Sistema cria Lead A + alias `(workspace, email_hash, A)`.
- T+2d: Mesma pessoa, em smartphone (sem cookie), se cadastra em LP Y com phone-only `+5511999999999`. Sistema cria Lead B + alias `(workspace, phone_hash, B)`.
- T+5d: Pessoa preenche form com email `foo@example.com` E phone `+5511999999999` (ex.: form de checkout exigindo ambos).

## Fluxo principal

1. POST `/v1/lead` com `email`, `phone`, attribution, consent.
2. Edge persiste em `raw_events`, retorna 202.
3. Ingestion processor chama `resolveLeadByAliases({email, phone})`.
4. Resolver consulta `lead_aliases` ativos: `WHERE workspace_id=W AND status='active' AND (identifier_type, identifier_hash) IN ((email_hash, He), (phone_hash, Hp))`.
5. Resultado: 2 leads (A via email_hash, B via phone_hash).
6. Resolver detecta N>1 → executa merge canônico.
7. Determina canonical: `lead.first_seen_at ASC LIMIT 1` → Lead A (mais antigo).
8. Merge transaction:
   a. UPDATE `events SET lead_id=A WHERE lead_id=B AND workspace_id=W`. Capture count = `events_reassigned`.
   b. UPDATE `lead_attribution SET lead_id=A WHERE lead_id=B`. Capture count.
   c. UPDATE `lead_stages SET lead_id=A WHERE lead_id=B`. Conflict de unique parcial em stages não-recorrentes resolvido por: skip insert se A já tem mesmo stage; senão move.
   d. UPDATE `lead_consents SET lead_id=A WHERE lead_id=B`.
   e. UPDATE `lead_survey_responses SET lead_id=A WHERE lead_id=B`.
   f. UPDATE `lead_icp_scores SET lead_id=A WHERE lead_id=B`.
   g. UPDATE `webinar_attendance SET lead_id=A WHERE lead_id=B` (com CONFLICT no unique `(workspace_id, lead_id, session_id)` — resolver: drop B's row se A já tem).
   h. UPDATE `lead_aliases SET lead_id=A, status='superseded' WHERE lead_id=B AND status='active'`. Para cada alias movido, criar alias novo com `lead_id=A, status='active'` se ainda não existe (usar `INSERT ... ON CONFLICT DO NOTHING`).
   i. UPDATE `lead_tokens SET lead_id=A WHERE lead_id=B`. Tokens de B continuam válidos para A (binding a page_token_hash inalterado).
   j. UPDATE `leads SET status='merged', merged_into_lead_id=A WHERE id=B`.
   k. INSERT `lead_merges` com `canonical_lead_id=A, merged_lead_id=B, reason='email_phone_convergence', performed_by='system', before_summary={leadA, leadB}, after_summary={leadA_merged}`.
   l. INSERT `audit_log` com `action='merge_leads', actor_type='system', entity_type='lead', entity_id=A`.
9. Resolver retorna `{lead_id=A, merge_executed=true, merged_lead_ids=[B]}`.
10. Processor continua fluxo padrão: cria event row, atualiza last-touch, cria dispatch jobs — tudo apontando para Lead A.
11. MARKETER vê (dashboard técnico) `lead_merges_executed` métrica incrementar; `lead_merges` row visível em audit.

## Fluxos alternativos

### A1 — Merge encadeado (transitividade)

Cenário: A já tem `merged_into_lead_id=X` (foi mergeado anteriormente); resolver acharia A mas A está merged.

7'. Resolver verifica `lead.status`:
   - Se `merged`: segue ponteiro `merged_into_lead_id` até encontrar `active`.
   - Lead canonical efetivo é o final da cadeia.
   - Cadeia profundas (A→B→C→D) limitada a 5 hops; se mais, abort + alerta.

### A2 — Conflito em stages não-recorrentes

8c'. Lead A tem `stage='registered'` (não-recorrente). Lead B tem `stage='registered'` no mesmo launch. Unique parcial impede dois `registered` no mesmo `(workspace, launch, lead)` — mas A já é canonical e B vai virar A:
   - Sistema mantém o stage de A (mais antigo); descarta o de B (idempotência semântica).
   - Resultado: A tem `registered` único.

### A3 — Conflito em alias (já active no A)

8h'. Move alias `(phone_hash, B)` para A. A já tem `(phone_hash, alguma_hash_diferente)` — mas hashes diferem (cenário improvável já que merge é por hash matching), não há conflito.

Caso patológico: dois leads ativos com mesmo phone_hash (não deveria existir, INV-IDENTITY-001), mas se aparecesse, merge falharia. Em prod, monitoring detecta.

### A4 — Lead `erased` na cadeia

7''. Resolver encontra lead com `status='erased'`:
   - Não pode merge para erased (BR-IDENTITY-004).
   - Resolver retorna error `cannot_resolve_to_erased`.
   - Evento aceito como anônimo + alerta operacional.

### A5 — Falha em meio à transaction

8'. UPDATE em events falha (DB error mid-transaction):
   - Transaction roll back.
   - `lead_merges` não é criado.
   - Resolver retorna error.
   - Evento entra em DLQ com `processing_error='merge_failed'`.
   - Idempotente: retry pode tentar de novo.

### A6 — Merge manual (admin)

OWNER/ADMIN pode forçar merge via Control Plane (Fase 4):
- Endpoint `/v1/admin/leads/:id/merge` com payload `{merge_into: lead_id}`.
- Validator checa que ambos são `active`, mesmo workspace.
- `reason='manual'`, `performed_by=actor_id`.
- Audit log obrigatório.

## Pós-condições

- Lead A `active` com aliases ampliados (email_hash + phone_hash).
- Lead B `merged`, `merged_into_lead_id=A`.
- Events/attribution/stages/consents/surveys/scores/webinars de B reapontam para A.
- `lead_merges` row criada.
- `audit_log` entry.

## TE-* emitidos

- TE-LEAD-MERGED-v1
- TE-EVENT-NORMALIZED-v1 (do evento original que disparou merge)

## Casos de teste E2E

1. **Convergência simples**: A (email) + B (phone) → identify (email+phone) → merge para A.
2. **Convergência tripla**: 3 leads com aliases parciais → todos merge para o mais antigo.
3. **Cadeia transitive**: A→B já existe; novo merge B→C; resolve até C.
4. **Stages duplicados**: A tem `registered` em launch L; B tem `registered` em L; merge mantém só de A.
5. **Audit log presente**: após merge, `audit_log where action='merge_leads'` existe com `before/after`.
