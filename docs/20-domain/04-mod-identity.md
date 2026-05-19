# MOD-IDENTITY — Leads, aliases, merges, consents, lead tokens, PII

## 1. Identidade

- **ID:** MOD-IDENTITY
- **Tipo:** Core (módulo mais sensível — PII, consent, merge)
- **Dono conceitual:** PRIVACY (políticas) + DOMAIN (lógica de resolução)

## 2. Escopo

### Dentro
- Leads com PII hash + criptografada (AES-256-GCM com `pii_key_version`).
- `lead_aliases` substituindo unique constraints (ADR-005).
- `lead_merges` para auditoria de fusões canônicas.
- `lead_consents` por finalidade (5 finalidades, ADR-010).
- `lead_tokens` para reidentificação em retornos (cookie `__ftk`, ADR-006).
- Algoritmo de resolução `resolveLeadByAliases()` com merge automático.
- Anonimização para SAR/erasure (RF-029).
- Helper `pii.ts` central com `hash()`, `encrypt()`, `decrypt()`, derivação HKDF por workspace.

### Fora
- UI de gerenciamento de privacy (Fase 4).
- Audit log per se (`MOD-AUDIT`); este módulo apenas chama `recordAuditEntry()`.

## 3. Entidades

### Lead
- `id`, `workspace_id`
- `external_id_hash`, `email_hash`, `phone_hash`, `name_hash` (workspace-scoped SHA-256)
- `email_hash_external`, `phone_hash_external`, `fn_hash`, `ln_hash` (T-OPB: SHA-256 puro para Meta/Google)
- `email_enc`, `phone_enc` (AES-256-GCM workspace-scoped)
- `name` (text plaintext, ADR-034 — indexado em `idx_leads_name_lower (lower(name) text_pattern_ops)` para search ILIKE)
- `name_enc` (DEPRECATED por ADR-034 — writers param de gravar; reads mantêm fallback por compat retroativa)
- `pii_key_version` (smallint, default 1)
- `status` (`active` / `merged` / `erased` / `archived`) — ver `LeadStatus` em `30-contracts/01-enums.md` para semântica.
- `lifecycle_status` (`LifecycleStatus` — `contato`/`lead`/`cliente`/`aluno`/`mentorado`; NOT NULL DEFAULT `contato`; CHECK constraint, migration `0042`, Sprint 16). Hierarquia monotônica não-regressiva — escrito por `promoteLeadLifecycle` sempre que um Purchase é processado ou um Lead/form é capturado. Derivado de `products.category` via `lifecycleForCategory`. Ver MOD-PRODUCT e BR-PRODUCT-001.
- `merged_into_lead_id` (FK, opcional — para registros pós-merge)
- `first_seen_at`, `last_seen_at`
- `created_at`, `updated_at`

### LeadAlias
- `id`, `workspace_id`
- `identifier_type` (`email_hash` / `phone_hash` / `external_id_hash` / `lead_token_id`)
- `identifier_hash`
- `lead_id` (FK)
- `source` (`form_submit` / `webhook:hotmart` / `manual` / `merge`)
- `status` (`active` / `superseded` / `revoked`)
- `ts`

### LeadMerge
- `id`, `workspace_id`
- `canonical_lead_id`
- `merged_lead_id`
- `reason` (`email_phone_convergence` / `manual` / `sar`)
- `performed_by` (`actor_id` ou `system`)
- `before_summary`, `after_summary` (jsonb com snapshot dos dois leads)
- `merged_at`

### LeadConsent
- `id`, `workspace_id`
- `lead_id` (FK)
- `event_id` (text — pode ser NULL para registros administrativos)
- `consent_analytics` (`granted` / `denied` / `unknown`)
- `consent_marketing`
- `consent_ad_user_data`
- `consent_ad_personalization`
- `consent_customer_match`
- `source`
- `policy_version`
- `ts`

### LeadToken
- `id`, `workspace_id`
- `lead_id` (FK)
- `token_hash` (SHA-256 do segredo emitido)
- `page_token_hash` (binding — token roubado não funciona em outra página)
- `issued_at`, `expires_at`, `revoked_at`, `last_used_at`

### LeadTag (T-LEADS-VIEW-001 — Sprint 16)
- `id` (uuid PK), `workspace_id` (FK → workspaces, ON DELETE CASCADE)
- `lead_id` (FK → leads, ON DELETE CASCADE — tag desaparece em hard-delete/SAR)
- `tag_name` (text — operator-defined; convenções vivem em `funnel_blueprint.tag_rules`)
- `set_at` (timestamptz, default now)
- `set_by` (text — proveniência; INV-LEAD-TAG-002 — formato `system | user:<uuid> | integration:<name> | event:<event_name>`; validação em service-layer, sem CHECK DB)
- **UNIQUE** `(workspace_id, lead_id, tag_name)` via index `uq_lead_tags_workspace_lead_tag` — INV-LEAD-TAG-001
- **RLS** policy `lead_tags_workspace_isolation` (dual-mode: GUC `app.current_workspace_id` + JWT-derived `auth_workspace_id()`)
- **Indexes:** `idx_lead_tags_workspace_tag (workspace_id, tag_name)` para "todos leads com tag X"; `idx_lead_tags_lead (lead_id)` para "todas tags de um lead"

Diferença canônica:
- `lead_stages` → progressão monotônica num funil (com `source_event_id`, recurring, etc.).
- `events` → fato pontual com timestamp.
- `lead_tags` → atributo binário do lead, atemporal, workspace-scoped.

Eventos podem disparar simultaneamente: stage promotion + tag set (ex.: `custom:wpp_joined` → stage `group_joined` + tag `joined_group`). Helpers `setLeadTag` / `applyTagRules` em `apps/edge/src/lib/lead-tags.ts` (ver MOD-IDENTITY § 10 e `30-contracts/07-module-interfaces.md`).

### WorkspaceTag — catálogo de tags do workspace (T-TAGS-001 — Sprint 18)

Catálogo opcional de metadados (cor, descrição, soft-delete) das tags utilizadas no workspace. **Não substitui** `lead_tags` — convive lado a lado:

- `lead_tags.tag_name` (já existente desde Sprint 16, migration 0044) → permanece **texto livre operator-defined**, escrito por blueprint `tag_rules` e integrações externas. Sem FK rígida para o catálogo.
- `workspace_tags` (nova — migration 0053) → catálogo de metadados de UI. Match com `lead_tags.tag_name` é **soft**, feito em service layer via `(workspace_id, name)`.

**Por que sem FK rígida (ADR-047):** compat retroativa (rows pré-catálogo permanecem válidas) + blueprints podem declarar `tag_rules` sem pré-cadastro + auto-registro pelo service layer sincroniza o catálogo de forma idempotente.

Schema:

- `id` (uuid PK), `workspace_id` (FK → workspaces, ON DELETE CASCADE)
- `name` (text — match com `lead_tags.tag_name`, mesmo charset)
- `color` (text NULL — hex `#rrggbb` ou token do design system; sem CHECK DB)
- `description` (text NULL — descrição livre exibida no catálogo)
- `created_by` (text — INV-WORKSPACE-TAG-002 — formato `user:<uuid> | system:auto-registered | system:blueprint`; validação em service layer)
- `created_at` (timestamptz, default now)
- `archived_at` (timestamptz NULL — soft-delete reversível; `NULL` = ativa)
- **UNIQUE** `(workspace_id, name)` via index `uq_workspace_tags_workspace_name` — INV-WORKSPACE-TAG-001
- **RLS** policy `workspace_tags_workspace_isolation` (dual-mode: GUC `app.current_workspace_id` + JWT-derived `auth_workspace_id()`)
- **Index:** `idx_workspace_tags_workspace_active (workspace_id) WHERE archived_at IS NULL` — partial index para o lookup mais frequente ("tags ativas do workspace" no catálogo e no tag picker)

Auto-registro (implementado Sprint 18 — `apps/edge/src/lib/workspace-tags.ts`): `autoRegisterTag(workspace_id, tag_name, source)` é chamado por:
- `applyTagRules` durante ingestion (source=`system:blueprint`) — após cada tag aplicada via `tag_rules` do blueprint, idempotente, falha logada sem bloquear.
- Route handlers de `/v1/leads-tags/*` (source=`user:<uuid>`) — antes de cada `setLeadTag` manual, em paralelo via `Promise.all`.

Rename é atômico em transação (`updateTag` em `lib/workspace-tags.ts`): `SELECT … FOR UPDATE` lock + UPDATE `workspace_tags.name` + UPDATE `lead_tags.tag_name` (workspace-scoped) na mesma `db.transaction`. Colisão de nome → rollback + `error: 'duplicate'`. Ver [BR-TAGS-005](../50-business-rules/BR-TAGS.md#br-tags-005).

### Fluxos do sistema de tags (Sprint 18 — T-TAGS-001 → T-TAGS-009)

**1. Aplicação automática via blueprint:** evento ingerido → `raw-events-processor` chama `applyTagRules` com o `eventName` e `tagRules` do `funnel_blueprint`. Para cada match: `setLeadTag(setBy='event:<name>')` + `autoRegisterTag(source='system:blueprint')` em sequência. Idempotente; falha não bloqueia o pipeline. BR-TAGS-001/003.

**2. Aplicação manual no detalhe do lead:** UI `apps/control-plane/src/app/(app)/contatos/[lead_public_id]/lead-summary-header.tsx` chama `POST /v1/leads-tags/by-lead/:lead_public_id { tag_names: [...] }`. Route handler resolve `lead_id` (workspace-scoped), itera `Promise.all` com `autoRegisterTag` + `setLeadTag` por tag. `set_by = "user:<uuid>"`. Audit agregado `lead_tag.set_batch`. BR-TAGS-010.

**3. Remoção manual:** `DELETE /v1/leads-tags/by-lead/:lead_public_id/:tag_name`. `unsetLeadTag` workspace-scoped; audit `lead_tag.unset` quando `removed=true`.

**4. Bulk apply em seleção de contatos:** UI `apps/control-plane/src/app/(app)/contatos/page.tsx` permite selecionar até 5000 leads e aplicar até 50 tags via `POST /v1/leads-tags/bulk-apply`. Cap imposto no Zod do route. Unknowns reportados em `unknown_public_ids[]`, não falham (BR-TAGS-007). Produto cartesiano via `unnest()` SQL — single INSERT.

**5. Filtro combinatório na lista de contatos:** UI envia `tag_filter = base64url(JSON.stringify({ op, clauses }))`. Endpoint `GET /v1/leads` decoda + valida via Zod; converte em fragmento SQL EXISTS/NOT EXISTS combinado por AND/OR (`buildTagFilterWhere` em `lib/leads-filter.ts`). Aplicado em `listLeads`, `countLeads`, `exportLeads` via campo opcional `tagFilter`. Nunca JOIN. BR-TAGS-008/009.

**6. Catálogo `/settings/tags`:** UI lista (`GET /v1/workspace-tags?with_count=true`), cria (`POST`), edita (`PATCH`), arquiva (`DELETE { cascade? }`), reativa (`POST /:id/unarchive`). Rename atômico (BR-TAGS-005); archive com cascade opcional (BR-TAGS-006).

## 4. Relações

- `Lead 1—N LeadAlias`
- `Lead 1—N LeadConsent`
- `Lead 1—N LeadToken`
- `Lead 1—1 Lead` (auto-relação via `merged_into_lead_id`)
- `Lead 1—N Event` (via `events.lead_id`)
- `Lead 1—N LeadStage`
- `Lead 1—N LeadAttribution`
- `Lead 1—N LeadSurveyResponse` (`MOD-ENGAGEMENT`)
- `Lead 1—N LeadIcpScore`
- `Lead 1—N WebinarAttendance`

## 5. Estados (Lead)

```
[active] ⇄ [archived]  (soft-hide reversível — PII intacta)
       → [merged]      (não pode voltar)
       → [erased]      (terminal — PII zerada por SAR)
```

## 6. Transições válidas

| De | Para | Quem | Notas |
|---|---|---|---|
| (criação) | `active` | sistema (resolveLeadByAliases) | — |
| `active` | `merged` | sistema (durante merge) | `merged_into_lead_id` populado; aliases movidos para canonical. |
| `active` | `erased` | PRIVACY, ADMIN (via `DELETE /v1/admin/leads/:id` ou `POST /v1/leads/bulk-delete` que enfileira worker `lead_erase`) | PII zerada; agregados preservados; aliases removidos. |
| `active` | `archived` | OWNER, ADMIN, PRIVACY (via `POST /v1/leads/bulk-archive`) | Soft-hide; PII intacta; ainda no workspace; excluído de listagem default. Audit `lead_archived`. |
| `archived` | `active` | OWNER, ADMIN, PRIVACY (via `POST /v1/leads/bulk-unarchive`) | Restaura visibilidade. Audit `lead_unarchived`. |

## 7. Invariantes

- **INV-IDENTITY-001 — Aliases ativos são únicos por `(workspace_id, identifier_type, identifier_hash)`.** Constraint `unique (...) where status='active'`. Testável.
- **INV-IDENTITY-002 — Lead `erased` não tem PII em claro.** Após SAR, `email_enc`, `phone_enc`, `name_enc` IS NULL e hashes IS NULL. Testável.
- **INV-IDENTITY-009 — Lead `archived` mantém PII intacta e segue no workspace.** Diferente de `erased`, archived é soft-hide reversível: `email_enc`/`phone_enc`/`name_enc`/`*_hash`/aliases permanecem inalterados; o lead apenas sai de listagens default (`GET /v1/leads?status=default`) e pode voltar via `bulk-unarchive`. Métricas históricas (dashboard) continuam contabilizando archived leads para não retroagir receita/ROAS. Testável.
- **INV-IDENTITY-003 — Lead `merged` não recebe novos aliases ou eventos.** Resolver direciona qualquer match para `merged_into_lead_id`. Eventos com `lead_id` de lead merged são rejeitados ou redirecionados pelo ingestion processor. Testável.
- **INV-IDENTITY-004 — Cada lead tem ao menos 1 alias `active` enquanto `lead.status='active'`.** Validador. Testável.
- **INV-IDENTITY-005 — `pii_key_version` corresponde a uma versão de chave existente.** Validador (config tem lista de versões disponíveis). Testável.
- **INV-IDENTITY-006 — `LeadToken` válido só com claim `page_token_hash` correspondente a `page_token` ativa ou rotating.** Validador no Edge. Testável.
- **INV-IDENTITY-007 — Hash de email/phone usa normalização canônica antes do SHA-256.** Email: lowercase + trim. Phone: E.164. Testável: `hash('  Foo@Bar.COM ') === hash('foo@bar.com')`.
- **INV-IDENTITY-008 — `leads.email_hash / phone_hash / email_enc / phone_enc / name_enc` são denormalizações do identifier ativo, populadas no momento da criação/atualização do lead.** Ao criar um novo lead (`createNewLead`), `emailHash` e `phoneHash` recebem os hashes dos aliases correspondentes; `enrichLeadPii` popula os ciphertexts `*_enc` no mesmo ciclo. Ao atualizar um lead existente (`updateExistingLead`), as colunas `*_hash` são atualizadas quando novos aliases de email/phone são fornecidos. **Os ciphertexts `email_enc / phone_enc / name_enc` espelham o identifier ativo** (ADR-044): `enrichLeadPii` decripta o ciphertext atual usando `pii_key_version` corrente e re-encripta com o `pii_key_version` corrente quando o plaintext input diverge do plaintext atual. NULL-check inicial preserva o comportamento de primeira escrita; pós-NULL, comparação por plaintext determina sobrescrita. Idempotente quando input == plaintext atual. Essa denormalização permite que o dispatcher verifique elegibilidade (presença de `user_data`) sem join em `lead_aliases` a cada despacho, e garante que UI/DSAR/audit log vejam o mesmo identifier que dispatchers enviam pra plataformas externas.
- **INV-IDENTITY-LASTSEEN-MONOTONIC — `leads.last_seen_at` é monotonicamente não-decrescente.** `resolveLeadByAliases(input, workspace_id, db, options?: { eventTime })` aplica `lastSeenAt = GREATEST(COALESCE(current, '-infinity'::timestamptz), eventTime ?? NOW())` no UPDATE — em casos B (lead existente) e C (mergeLeads → canonical). No caso A (createNewLead), `firstSeenAt = lastSeenAt = eventTime ?? NOW()`. Backfills/replays de eventos antigos não bumpam o timestamp para trás (nem para frente além do event_time real). `updatedAt` continua sempre `= NOW()` (separado de last_seen_at). Testável: `tests/unit/identity/lead-resolver-lastseen-monotonic.test.ts`. Ver BR-IDENTITY-008.
- **INV-LEAD-TAG-001 — `(workspace_id, lead_id, tag_name)` é único em `lead_tags`.** Garantido via UNIQUE index + UPSERT idempotente em `setLeadTag` (`ON CONFLICT DO NOTHING`).
- **INV-LEAD-TAG-002 — `lead_tags.set_by` segue formato canônico `system | user:<uuid> | integration:<name> | event:<event_name>`.** Validação no service layer (não há CHECK DB — flexibilidade para novas fontes sem migration).
- **INV-WORKSPACE-TAG-001 — `(workspace_id, name)` é único em `workspace_tags`.** Garantido via UNIQUE index `uq_workspace_tags_workspace_name`. Auto-registro deve usar UPSERT idempotente (`ON CONFLICT DO NOTHING`).
- **INV-WORKSPACE-TAG-002 — `workspace_tags.created_by` segue formato canônico `user:<uuid> | system:auto-registered | system:blueprint`.** Validação no service layer (sem CHECK DB — mesmo padrão de `lead_tags.set_by` / INV-LEAD-TAG-002).
- **INV-WORKSPACE-TAG-003 — Relação `workspace_tags ↔ lead_tags` é soft.** Match por `(workspace_id, name)`, sem FK rígida. `lead_tags.tag_name` permanece texto livre por compat retroativa e para suportar `tag_rules` de blueprints / integrações externas. Sync via service layer (auto-registro + rename atômico). Decisão em ADR-047.

### Storage de `visitor_id`

`visitor_id` é o UUID v4 anônimo do cookie `__fvid` (gerado pelo tracker). Storage segue padrão **coluna dedicada** — não JSONB.

| Origem | Campo no payload | Destino no DB | Observação |
|---|---|---|---|
| `POST /v1/events` (tracker.js) | `visitor_id` (top-level — `EventPayloadSchema.visitor_id`) | `events.visitor_id` (coluna) | Caminho canônico. Extraído antes do insert por `raw-events-processor` (Step 6). |
| `POST /v1/lead` (form submit) | — não enviado (`LeadPayloadSchema` não tem o campo) — | `events.visitor_id = NULL` | `lead_identify` é evento interno; nunca dispatcha pra plataformas externas. |
| `POST /v1/webhooks/*` (Guru, SendFlow, Hotmart…) | — não enviado — | `events.visitor_id = NULL` | Webhooks são server-side; nunca tiveram cookie no request. |

**Backfill retroativo `visitor_id → lead_id`** (INV-EVENT-007 — `raw-events-processor` Step 8): quando um lead é resolvido e o evento corrente tem `visitor_id`, eventos anteriores com mesmo `visitor_id` mas `lead_id IS NULL` recebem o `lead_id` retroativamente. Permite atribuir `PageView` anônimo ao lead que se identificou depois (mesma INV-TRACKER-003: `visitor_id` só aparece com `consent_analytics='granted'`).

**Inspeção / debug — o que NÃO fazer:** olhar `events.user_data->>'external_id'` ou `events.user_data->>'fvid'`. Esses caminhos JSONB **não** carregam o visitor_id — o caminho canônico é a coluna `events.visitor_id`. Use `SELECT visitor_id FROM events WHERE …`. O `UserDataSchema` (`apps/edge/src/routes/schemas/event-payload.ts`) só aceita `_ga`, `_gcl_au`, `fbc`, `fbp`, `client_ip_address`, `client_user_agent` (mais geo computed pelo edge); qualquer outro campo é stripado por `INV-EVENT-004`.

**Uso pelo Meta CAPI:** `apps/edge/src/dispatchers/meta-capi/mapper.ts` lê `event.visitor_id` (coluna) e atribui a `userData.external_id` no payload Meta — em **plano**, sem hash (ADR-031, Sprint 16). UUID v4 random não é PII reversível; Meta hashea internamente.

## 8. BRs relacionadas

- `BR-IDENTITY-*` — todas em `50-business-rules/BR-IDENTITY.md`.
- `BR-PRIVACY-*` — em `BR-PRIVACY.md`.
- `BR-CONSENT-*` — em `BR-CONSENT.md`.
- `BR-PRODUCT-001` — `lifecycle_status` é monotônico (write-side delegado a `MOD-PRODUCT.promoteLeadLifecycle`). Ver `BR-PRODUCT.md`.
- `BR-TAGS-*` — sistema de tags (lead_tags + workspace_tags + filtro combinatório). Ver [`BR-TAGS.md`](../50-business-rules/BR-TAGS.md).

## 9. Contratos consumidos

- `MOD-WORKSPACE.deriveWorkspaceCryptoKey()`
- `MOD-AUDIT.recordAuditEntry()` (em merge, erasure, decrypt access)

## 10. Contratos expostos

- `resolveLeadByAliases({email, phone, external_id}, workspace_id, ctx, options?: { eventTime?: Date }): Result<{lead_id, was_created, merge_executed, merged_lead_ids}, ResolutionError>` — `options.eventTime` (Sprint 16) é usado como `first_seen_at` (caso A) e como candidato a `last_seen_at` via `GREATEST` (casos B e C). Omitir = `NOW()`. Ver INV-IDENTITY-LASTSEEN-MONOTONIC.
- `setLeadTag({ db, workspaceId, leadId, tagName, setBy }): { ok: true } | { ok: false; error }` — UPSERT idempotente em `lead_tags` (`apps/edge/src/lib/lead-tags.ts`). INV-LEAD-TAG-001/002. Ver [BR-TAGS-001/002](../50-business-rules/BR-TAGS.md).
- `applyTagRules({ db, workspaceId, leadId, eventName, eventContext?, tagRules, requestId? }): { applied, skipped }` — lê regras do blueprint (`tag_rules[]`), filtra por `event` + `when` (AND lógico de keys), chama `setLeadTag` para cada match + `autoRegisterTag(source='system:blueprint')` para sincronizar catálogo. Não levanta — falhas viram log + `skipped++`.
- `unsetLeadTag({ db, workspaceId, leadId, tagName }): { ok: true; removed } | { ok: false; error }` — DELETE workspace-scoped. Not-found vira `removed: false` (idempotente). BR-TAGS-001.
- `bulkApplyLeadTagsByIds({ db, workspaceId, leadIds[], tagNames[], setBy, requestId? }): { applied, skipped }` — produto cartesiano via `unnest(uuid[]) × unnest(text[])` em single INSERT … SELECT com `ON CONFLICT DO NOTHING`. Cap operacional 5000 × 50 imposto no route layer. BR-TAGS-001/007.
- `bulkUnsetLeadTagsByIds({ db, workspaceId, leadIds[], tagNames[] }): { removed }` — DELETE em lote via `ANY()`. BR-TAGS-007.
- `autoRegisterTag({ db, workspaceId, name, source }): { ok: true } | { ok: false; error }` — INSERT idempotente em `workspace_tags` (`ON CONFLICT (workspace_id, name) DO NOTHING`). Não modifica `created_by` da row existente. Chamado por `setLeadTag` (route layer, source=`user:<uuid>`) e por `applyTagRules` (source=`system:blueprint`). BR-TAGS-003/004.
- `createTag({ db, workspaceId, name, color?, description?, createdBy }): { ok: true; tag } | { ok: false; error: 'duplicate' | 'unknown' }` — variante "operador manual": sinaliza `duplicate` explicitamente em vez de no-op idempotente. BR-TAGS-003.
- `updateTag({ db, workspaceId, tagId, patch: { name?, color?, description? } }): Result<{ tag }, 'not_found' | 'duplicate'>` — rename **atômico** em transação (SELECT FOR UPDATE + UPDATE wt + UPDATE lt). BR-TAGS-005 / INV-WORKSPACE-TAG-003.
- `archiveTag({ db, workspaceId, tagId, cascade }): { ok: true; archived, cascaded } | { ok: false; error }` — soft-delete (`archived_at = NOW()`). Quando `cascade=true`, DELETE `lead_tags WHERE tag_name = name` na mesma transação. BR-TAGS-006.
- `unarchiveTag({ db, workspaceId, tagId }): { ok: true; unarchived } | { ok: false; error }` — reverte archive.
- `listTags({ db, workspaceId, includeArchived?=false, withCount?=false }): WorkspaceTagRow[]` — ordenado por `name ASC`. `withCount` opt-in (subquery `COUNT(*) FROM lead_tags`).
- `buildTagFilterWhere(filter: TagFilter | null, workspaceId, leadIdColumn?): SQL | null` (`apps/edge/src/lib/leads-filter.ts`) — gera fragmento SQL com EXISTS/NOT EXISTS combinados por `AND`/`OR`. Caller passa via `tagFilter?` em `ListLeadsOpts`/`CountLeadsOpts`/`ExportLeadsOpts`. NUNCA JOIN (BR-TAGS-008). Consumido pelo handler de `GET /v1/leads` (formato wire `tag_filter = base64url(JSON)` — BR-TAGS-009).
- `createLeadConsent(lead_id, consent, source, policy_version, ctx): Result<LeadConsent>`
- `getLatestConsent(lead_id, finality): Result<ConsentValue, NotFound>` — para dispatcher checar consent antes de envio.
- `issueLeadToken(lead_id, page_token_hash, ttl_days, ctx): Result<{token_clear, expires_at}>`
- `validateLeadToken(token_clear, current_page_token_hash, ctx): Result<{lead_id}, InvalidToken | Expired | Revoked | PageMismatch>`
- `revokeLeadToken(token_id, actor, ctx): Result<void>`
- `eraseLead(lead_id, actor, ctx): Result<{events_anonymized, attribution_anonymized}, NotFound>`
- `decryptLeadPII(lead_id, fields[], actor, ctx): Result<{email?, phone?, name?}, Forbidden>` — exige role privacy/owner; gera audit log.

## 11. Eventos de timeline emitidos

- `TE-LEAD-CREATED`
- `TE-LEAD-UPDATED`
- `TE-LEAD-MERGED`
- `TE-LEAD-ERASED`
- `TE-LEAD-CONSENT-RECORDED`
- `TE-LEAD-TOKEN-ISSUED`
- `TE-LEAD-TOKEN-REVOKED`
- `TE-LEAD-PII-DECRYPTED-ACCESS` (audit técnico)

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/lead.ts`
- `packages/db/src/schema/lead_alias.ts`
- `packages/db/src/schema/lead_merge.ts`
- `packages/db/src/schema/lead_consent.ts`
- `packages/db/src/schema/lead_token.ts`
- `packages/db/src/schema/lead_tag.ts`
- `packages/db/src/schema/workspace_tag.ts`
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/lead-tags.ts`
- `apps/edge/src/lib/workspace-tags.ts`
- `apps/edge/src/lib/leads-filter.ts`
- `apps/edge/src/lib/lead-token.ts`
- `apps/edge/src/lib/pii.ts`
- `apps/edge/src/lib/pii-enrich.ts`
- `apps/edge/src/lib/consent.ts`
- `apps/edge/src/lib/cookies.ts` (set/read `__ftk`)
- `apps/edge/src/routes/admin/leads-erase.ts`
- `apps/edge/src/routes/workspace-tags.ts`
- `apps/edge/src/routes/leads-tags.ts`
- `tests/unit/identity/**`
- `tests/integration/identity/**`

**Lê:**
- `apps/edge/src/lib/workspace.ts`
- `apps/edge/src/lib/audit.ts`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-WORKSPACE`, `MOD-AUDIT`.
**Proibidas:** `MOD-EVENT`, `MOD-DISPATCH`, `MOD-AUDIENCE` (eles consomem MOD-IDENTITY, não o contrário).

## 14. Test harness

- `tests/unit/identity/hash-normalization.test.ts` — INV-IDENTITY-007.
- `tests/unit/identity/lead-resolver-no-match.test.ts` — caso 0 leads → criar.
- `tests/unit/identity/lead-resolver-single-match.test.ts` — caso 1 lead → atualizar.
- `tests/unit/identity/lead-resolver-merge.test.ts` — caso N>1 leads → merge canônico.
- `tests/unit/identity/lead-token-hmac.test.ts` — geração e validação de HMAC.
- `tests/unit/identity/pii-encryption.test.ts` — encrypt/decrypt com `pii_key_version`.
- `tests/unit/identity/pii-key-rotation.test.ts` — leitura com versão antiga; escrita com versão nova.
- `tests/integration/identity/erasure.test.ts` — INV-IDENTITY-002.
- `tests/integration/identity/merge-fk-update.test.ts` — events/lead_attribution movem para canonical.
- `tests/integration/identity/lead-token-page-binding.test.ts` — INV-IDENTITY-006.
