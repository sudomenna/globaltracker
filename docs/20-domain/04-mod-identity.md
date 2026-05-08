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
- `status` (`active` / `merged` / `erased`)
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
[active] → [merged]   (não pode voltar)
       → [erased]   (terminal — PII zerada por SAR)
```

## 6. Transições válidas

| De | Para | Quem | Notas |
|---|---|---|---|
| (criação) | `active` | sistema (resolveLeadByAliases) | — |
| `active` | `merged` | sistema (durante merge) | `merged_into_lead_id` populado; aliases movidos para canonical. |
| `active` | `erased` | PRIVACY, ADMIN (via `DELETE /v1/admin/leads/:id`) | PII zerada; agregados preservados; aliases removidos. |

## 7. Invariantes

- **INV-IDENTITY-001 — Aliases ativos são únicos por `(workspace_id, identifier_type, identifier_hash)`.** Constraint `unique (...) where status='active'`. Testável.
- **INV-IDENTITY-002 — Lead `erased` não tem PII em claro.** Após SAR, `email_enc`, `phone_enc`, `name_enc` IS NULL e hashes IS NULL. Testável.
- **INV-IDENTITY-003 — Lead `merged` não recebe novos aliases ou eventos.** Resolver direciona qualquer match para `merged_into_lead_id`. Eventos com `lead_id` de lead merged são rejeitados ou redirecionados pelo ingestion processor. Testável.
- **INV-IDENTITY-004 — Cada lead tem ao menos 1 alias `active` enquanto `lead.status='active'`.** Validador. Testável.
- **INV-IDENTITY-005 — `pii_key_version` corresponde a uma versão de chave existente.** Validador (config tem lista de versões disponíveis). Testável.
- **INV-IDENTITY-006 — `LeadToken` válido só com claim `page_token_hash` correspondente a `page_token` ativa ou rotating.** Validador no Edge. Testável.
- **INV-IDENTITY-007 — Hash de email/phone usa normalização canônica antes do SHA-256.** Email: lowercase + trim. Phone: E.164. Testável: `hash('  Foo@Bar.COM ') === hash('foo@bar.com')`.
- **INV-IDENTITY-008 — `leads.email_hash` e `leads.phone_hash` são populados (denormalizados) no momento da criação/atualização do lead por `resolveLeadByAliases()`.** Ao criar um novo lead (`createNewLead`), `emailHash` e `phoneHash` recebem os hashes dos aliases correspondentes. Ao atualizar um lead existente (`updateExistingLead`), as colunas são atualizadas quando novos aliases de email/phone são fornecidos. Essa denormalização permite que o dispatcher verifique elegibilidade (presença de `user_data`) sem join em `lead_aliases` a cada despacho.

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

## 9. Contratos consumidos

- `MOD-WORKSPACE.deriveWorkspaceCryptoKey()`
- `MOD-AUDIT.recordAuditEntry()` (em merge, erasure, decrypt access)

## 10. Contratos expostos

- `resolveLeadByAliases({email, phone, external_id}, workspace_id, ctx): Result<{lead_id, was_created, merge_executed, merged_lead_ids}, ResolutionError>`
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
- `apps/edge/src/lib/lead-resolver.ts`
- `apps/edge/src/lib/lead-token.ts`
- `apps/edge/src/lib/pii.ts`
- `apps/edge/src/lib/consent.ts`
- `apps/edge/src/lib/cookies.ts` (set/read `__ftk`)
- `apps/edge/src/routes/admin/leads-erase.ts`
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
