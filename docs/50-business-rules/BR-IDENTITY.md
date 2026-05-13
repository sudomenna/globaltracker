# BR-IDENTITY — Regras de identidade de leads

## BR-IDENTITY-001 — Aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)

### Status
Stable.

### Enunciado
Não pode existir mais de um row em `lead_aliases` com mesmo `(workspace_id, identifier_type, identifier_hash)` onde `status='active'`.

### Motivação
Garante integridade referencial do mapeamento `identifier → lead_id`. Sem isso, mesmo email teria múltiplos lead_ids ativos, quebrando merge canônico.

### Enforcement
- **DB:** `unique partial index on (workspace_id, identifier_type, identifier_hash) where status='active'`.
- **Domain:** `resolveLeadByAliases()` deve marcar aliases anteriores do mesmo `(lead_id, identifier_type)` como `superseded` antes de inserir um novo `identifier_hash` daquele type. Aplica em todos os caminhos do resolver:
  - **path "existing lead, novo hash"** (form re-submit corrigindo typo, troca de telefone, etc.) — corrigido 2026-05-09 (commit do fix do lead `75b3ed42`).
  - **path "merge"** — semântica diferente (uma pessoa com múltiplos identificadores legítimos): NÃO supersede automaticamente.

### Aplica-se a
MOD-IDENTITY, FLOW-02, FLOW-08.

### Critérios de aceite

```gherkin
Scenario: insert duplicado é rejeitado
  Given lead alias active (workspace=w, type=email_hash, hash=H, lead=A)
  When tentar inserir alias active (workspace=w, type=email_hash, hash=H, lead=B)
  Then deve falhar com unique constraint violation

Scenario: superseded permite mesmo identifier ativo em outro lead após merge
  Given lead alias active (workspace=w, type=email_hash, hash=H, lead=A)
  When merge move alias para canonical lead C, marca A como superseded
  Then novo alias active para mesmo (w, email_hash, H) → C é permitido

Scenario: aliases em workspaces diferentes não conflitam
  Given lead alias active (workspace=w1, type=email_hash, hash=H, lead=A)
  When inserir alias active (workspace=w2, type=email_hash, hash=H, lead=B)
  Then deve permitir

Scenario: re-submit com email corrigido marca o anterior como superseded (anti cross-contamination)
  Given lead L ativo com aliases (email_hash=H_typo) + (phone_hash=H_phone)
        e leads.email_enc = encrypt(plaintext_typo)
  When form submit chega com (email=H_correto, phone=H_phone)
  Then resolver bate por phone, reusa lead L
  And UPDATE lead_aliases SET status='superseded' WHERE lead_id=L AND identifier_type='email_hash' AND status='active'
  And INSERT lead_aliases (email_hash=H_correto, status='active')
  And UPDATE leads SET email_enc=encrypt(plaintext_correto), email_hash=H_correto (ADR-044 — espelha identifier ativo)
  And visitante futuro digitando exatamente H_typo NÃO é mergeado em L
```

### Mensagem de erro
`"identifier_already_in_use"` — para o usuário: "Esse identificador já está vinculado a outro lead."

### Citação em código
```ts
// BR-IDENTITY-001: aliases ativos são únicos por (workspace_id, identifier_type, identifier_hash)
```

---

## BR-IDENTITY-002 — Hash de email/phone usa normalização canônica antes do SHA-256

### Status
Stable.

### Enunciado
Antes de aplicar SHA-256, email **DEVE** ser normalizado para lowercase + trim. Phone **DEVE** ser convertido para E.164 (com `+` e código de país, sem espaços/hífens/parênteses).

Para números brasileiros, a normalização também **DEVE reconciliar o "9" extra** mandatório em celulares desde 2014 (Anatel): inputs com 8 dígitos local-part começando com 6/7/8/9 são interpretados como mobile-sem-9 e canonicalizados inserindo o "9" entre DDD e número local. Heurística é determinística porque landlines BR nunca começam com 6-9 (começam com 2-5).

### Motivação
Hashes diferentes para o mesmo identificador real quebram matching e dedup. `Foo@Bar.COM` e `foo@bar.com` representam a mesma pessoa para fins de identidade.

Em phone BR especificamente: sistemas externos (SendFlow, CRMs legados, exports de planilha) frequentemente armazenam celulares no formato pré-2014 sem o "9". Sem reconciliação, o mesmo lead capturado via form do site (com 9) e via webhook desses sistemas (sem 9) gera dois `phone_hash` distintos → matching quebra silenciosamente, lead é duplicado.

### Enforcement
- **Domain:** funções `normalizeEmail()`, `normalizePhone()` em [`apps/edge/src/lib/lead-resolver.ts`](../../apps/edge/src/lib/lead-resolver.ts). `normalizePhone` é BR-aware (T-13-014).
- **Edge:** Zod schema chama normalização antes de hash.

### Invariante derivada
**INV-IDENTITY-008**: Toda string `phone` armazenada em `phone_hash` (e o plaintext reconstituível em `phone_enc`) usa formato canônico:
- BR mobile: 13 dígitos, `+55DD9XXXXXXXX` (com `+` e o "9" entre DDD e número).
- BR landline: 12 dígitos, `+55DDXXXXXXXX`.
- Internacional: E.164 com `+` e country code não-55, sem mudança de prefixo.

### Aplica-se a
MOD-IDENTITY, MOD-EVENT (user_data), MOD-DISPATCH (Meta CAPI parameters).

### Critérios de aceite

```gherkin
Scenario: email com case e espaço é normalizado
  Given input "  Foo@Bar.COM "
  When hashEmail aplica
  Then resultado igual a hashEmail("foo@bar.com")

Scenario: phone com formatação variada é normalizado
  Given inputs "(11) 99999-9999", "+5511999999999", "11 9 9999 9999"
  When hashPhone aplica e país inferido = BR
  Then todos resultam no mesmo hash

Scenario: phone BR mobile sem o "9" é reconciliado para canônico
  Given inputs "555195849212", "+555195849212", "(51) 9584-9212", "5195849212"
  When hashPhone aplica
  Then todos resultam no mesmo hash de "+5551995849212"

Scenario: phone BR landline mantém 12 dígitos sem inserir 9
  Given inputs "5132345678", "+555132345678", "(51) 3234-5678"
  When hashPhone aplica
  Then todos resultam no mesmo hash de "+555132345678"

Scenario: phone sem código de país requer país explícito
  Given input "9999-9999" sem default country
  When hashPhone aplica
  Then deve retornar erro "phone_normalization_failed"
```

### Citação em código
```ts
// BR-IDENTITY-002: normalizar antes de hashear
const hash = sha256(normalizeEmail(email));
```

---

## BR-IDENTITY-003 — Lead com múltiplos aliases convergentes é mergeado canônico

### Status
Stable.

### Enunciado
Quando `resolveLeadByAliases({email, phone, external_id})` encontra 2+ leads ativos com aliases que coincidem, o sistema **DEVE** executar merge canônico imediato (não criar lead novo, não falhar). Lead canonical = lead mais antigo por `first_seen_at`.

### Motivação
Identidade fragmentada (lead A com email-only, lead B com phone-only, T+5 mesma pessoa preenche email+phone) é cenário real. Sem merge automático, sistema fica preso ou cria triplicata.

### Enforcement
- **Domain:** `resolveLeadByAliases()` em `apps/edge/src/lib/lead-resolver.ts`. Fluxo: 0 leads → criar; 1 → atualizar; N>1 → merge.
- **Audit:** cada merge gera `lead_merges` row + `audit_log` com action `merge_leads`.

### Aplica-se a
MOD-IDENTITY, FLOW-02, FLOW-08.

### Critérios de aceite

```gherkin
Scenario: convergência simples
  Given lead A com email_hash=He (criado T0)
  And lead B com phone_hash=Hp (criado T+2d)
  When recebe identify {email→He, phone→Hp} em T+5d
  Then lead A é canonical, B → status='merged', merged_into_lead_id=A
  And lead_merges row criada com canonical_lead_id=A, merged_lead_ids=[B]
  And events de B reapontam para A
  And lead_attribution de B reaponta para A
  And aliases de B → status='superseded'; aliases novos para B em A são active

Scenario: 3 leads convergentes
  Given leads A, B, C com aliases parcialmente sobrepostos
  When identify reúne todos identifiers
  Then A (mais antigo) é canonical; B e C → merged

Scenario: lead canonical já merged
  Given lead A merged_into_lead_id=X
  When tentativa de merge B com A
  Then redireciona para X (transitividade resolvida)
```

### Citação em código
```ts
// BR-IDENTITY-003: convergência → merge canônico (mais antigo wins)
```

---

## BR-IDENTITY-004 — Lead `merged` ou `erased` não recebe novos eventos ou aliases

### Status
Stable.

### Enunciado
Após `lead.status` virar `merged` ou `erased`, o lead **NÃO PODE** ser destino de novos `events.lead_id`, `lead_attribution.lead_id`, `lead_stages.lead_id` ou `lead_aliases` ativos.

### Motivação
- `merged`: novo evento deve ir para canonical, não para o lead absorvido.
- `erased`: lead foi anonimizado (SAR); não pode "reviver" via novo evento.

### Enforcement
- **Domain:** ingestion processor verifica `lead.status` antes de associar evento.
- **DB:** trigger ou check pode bloquear (decisão na Fase 1).

### Aplica-se a
MOD-IDENTITY, MOD-EVENT, MOD-ATTRIBUTION.

### Critérios de aceite

```gherkin
Scenario: evento direcionado a lead merged é redirecionado
  Given lead B merged_into=A
  When evento chega com lead_id=B
  Then ingestion processor reescreve para lead_id=A antes de insert em events

Scenario: evento direcionado a lead erased é descartado
  Given lead E status='erased'
  When evento chega com lead_id=E
  Then evento é rejeitado com processing_status='rejected_lead_erased'
```

### Citação em código
```ts
// BR-IDENTITY-004: redirect merged; reject erased
```

---

## BR-IDENTITY-005 — `lead_token` HMAC tem binding obrigatório a `page_token_hash`

### Status
Stable (ADR-006).

### Enunciado
Claim do `lead_token` (HMAC-SHA256) **DEVE** incluir `page_token_hash` da página onde foi emitido. Validação no Edge **DEVE** comparar com `page_token_hash` corrente da página onde o token está sendo apresentado.

### Motivação
Token roubado via XSS em uma página não deve funcionar em outra página do mesmo workspace — limita blast radius.

### Enforcement
- **Domain:** `issueLeadToken()` em `apps/edge/src/lib/lead-token.ts` inclui `page_token_hash` no claim. `validateLeadToken()` recebe page_token_hash atual e compara.

### Aplica-se a
MOD-IDENTITY, FLOW-07.

### Critérios de aceite

```gherkin
Scenario: token válido na mesma página
  Given token emitido para page P (page_token_hash=H1)
  When request a /v1/events com X-Funil-Site=P (hash=H1) e lead_token
  Then validação retorna ok com lead_id

Scenario: token apresentado em outra página falha
  Given token emitido para page P1 (hash=H1)
  When request a /v1/events com X-Funil-Site=P2 (hash=H2) e mesmo lead_token
  Then validação falha com 'page_mismatch'
  And evento aceito como anônimo (sem lead_id)
  And métrica lead_token_validation_failures incrementa

Scenario: token aceito durante rotação da page
  Given token emitido com hash=H_old
  And page_token rotacionado: H_new active, H_old rotating
  When request com X-Funil-Site (hash=H_old; page_token tem status='rotating')
  Then validação aceita (binding ainda válido)
```

### Citação em código
```ts
// BR-IDENTITY-005: lead_token tem binding a page_token_hash
```

---

## BR-IDENTITY-006 — Acesso a PII em claro: matriz por role + audit (ampliado por ADR-034)

### Status
Stable (AUTHZ-001) — ampliada via ADR-034 (2026-05-08).

### Enunciado

Acesso a `email`/`phone` em claro segue a matriz por role:

| Role | Lista (`/v1/leads`) | Detalhe (`/v1/leads/:id`) | Reveal-on-demand | Audit |
|---|---|---|---|---|
| `owner` | claro | claro | n/a | (acesso natural — sem audit) |
| `admin` | claro | claro | n/a | (sem audit) |
| `marketer` | claro | claro | n/a | (sem audit) |
| `privacy` | claro | claro | n/a | sim, em toda decifragem |
| `operator` | mascarado | mascarado | sim, via `POST /v1/leads/:id/reveal-pii` | sim, on reveal |
| `viewer` | mascarado | mascarado | proibido (403) | n/a (sempre denied) |

**Mascaramento** (BR-IDENTITY-007 derivado):
- Email → `<1ª letra>***@<domínio>` (ex.: `t***@gmail.com`).
- Phone → `+<DDI> <DDD> <1º dígito>****-<últimos 4>` (ex.: `+55 11 9****-7777`).

**`name`** (nome do lead) **deixou de ser PII protegido** (ADR-034) — armazenado plaintext em `leads.name` para search ILIKE. Sempre visível em todos roles.

### Motivação
PII em claro de email/phone é dado sensível do sistema. Acesso sem audit é violação de LGPD/GDPR. ADR-034 amplia roles privilegiadas (`admin`, `marketer`) reconhecendo que são roles operacionais internos que precisam de acesso natural para suporte ao cliente, mantendo `operator` em fluxo de reveal-consciente e `viewer` totalmente bloqueado.

### Enforcement
- **Domain:** `decryptLeadPII()` valida role + chama `recordAuditEntry()` antes de retornar valor (apenas para `privacy` e quando `operator` revela on-demand).
- **API:** `/v1/leads` aplica máscara conforme role do JWT antes de retornar. `POST /v1/leads/:id/reveal-pii` exige role ≥ `operator`, grava audit.

### Aplica-se a
MOD-IDENTITY, MOD-AUDIT.

### Critérios de aceite

```gherkin
Scenario: admin lê lista; PII em claro; sem audit
  Given role=admin
  When GET /v1/leads
  Then response items têm display_email e display_phone em claro
  And nenhum audit_log row criado

Scenario: operator lê lista; PII mascarado
  Given role=operator
  When GET /v1/leads
  Then response items têm display_email mascarado (formato a***@dominio.com)
  And display_phone mascarado (formato +55 DD 9****-XXXX)

Scenario: operator revela PII de um lead específico
  Given role=operator
  When POST /v1/leads/<id>/reveal-pii com body { reason: "suporte cliente #12345" }
  Then retorna email e phone em claro
  And audit_log row criada com action='read_pii_decrypted', actor_id, target_lead_id, fields_accessed=['email','phone'], reason

Scenario: viewer tenta revelar PII
  Given role=viewer
  When POST /v1/leads/<id>/reveal-pii
  Then retorna 403 'forbidden_role'
  And audit_log row criada com action='read_pii_decrypted_denied'
```

### Citação em código
```ts
// BR-IDENTITY-006 (ADR-034): role ≥ marketer → PII em claro; operator → reveal+audit; viewer → bloqueado
```

---

## BR-IDENTITY-008 — `leads.last_seen_at` reflete o tempo do evento mais recente, não o tempo de processamento

### Status
Stable (Sprint 16 — T-CONTACTS-LASTSEEN-002).

### Enunciado
`leads.last_seen_at` **DEVE** corresponder ao maior `event_time` (timestamp de origem, não de processamento) entre todos os eventos já associados ao lead. Replays e backfills de eventos antigos **NÃO PODEM** regredir o valor para o passado nem bumpá-lo para `NOW()` quando o evento real é antigo.

### Motivação
- `last_seen_at` é a métrica de "última atividade" exibida no Control Plane (tela Contatos, ranking de engajamento).
- Reprocessar eventos antigos (replay de webhook, recovery via Guru REST API, migrations de raw_events) não é nova atividade do lead — é trabalho de infraestrutura.
- Sem essa garantia: replay de webhook semana atrás faz lead "reaparecer" no topo da lista; ou pior, ordem cronológica é destruída e leads recém-ativos somem.

### Enforcement
- **Domain:** `resolveLeadByAliases(input, workspace_id, db, options?: { eventTime })` aceita `options.eventTime` opcional. Implementação em `apps/edge/src/lib/lead-resolver.ts`:
  - Caso A (`createNewLead`): `firstSeenAt = lastSeenAt = eventTime ?? NOW()`.
  - Caso B (`updateExistingLead`): `lastSeenAt = GREATEST(COALESCE(current, '-infinity'::timestamptz), eventTime ?? NOW())`.
  - Caso C (`mergeLeads`): mesmo `GREATEST` aplicado ao canonical.
  - `updatedAt` sempre `= NOW()` (decorrelacionado de `last_seen_at`).
- **Call sites:**
  - `routes/lead.ts` (live form submit) → `new Date()`.
  - `lib/raw-events-processor.ts` (tracker pipeline) → `new Date(payload.event_time)`.
  - `lib/guru-raw-events-processor.ts` (Guru webhook) → `dates.confirmed_at ?? created_at ?? rawEvent.receivedAt`.
  - `routes/webhooks/sendflow.ts` → `payload.data.createdAt` com fallback.
- **Retrocompat:** `options?` opcional — call sites legacy sem `eventTime` mantêm comportamento `NOW()` (live submit semantics).

### Invariante derivada
**INV-IDENTITY-LASTSEEN-MONOTONIC** — `leads.last_seen_at` é monotonicamente não-decrescente. Garantido por `GREATEST(current, candidate)` em todos os UPDATE paths do resolver.

### Aplica-se a
MOD-IDENTITY, MOD-EVENT (raw-events-processor), MOD-WEBHOOK (guru/sendflow).

### Critérios de aceite

```gherkin
Scenario: live form submit usa NOW
  Given lead L sem last_seen_at
  When POST /v1/lead → resolveLeadByAliases sem options.eventTime
  Then leads.last_seen_at ≈ NOW()

Scenario: webhook com event_time recente avança last_seen_at
  Given lead L last_seen_at = 2026-01-01
  When webhook chega com event_time = 2026-05-08 → resolveLeadByAliases com options.eventTime = 2026-05-08
  Then leads.last_seen_at = 2026-05-08

Scenario: replay de webhook antigo NÃO regride last_seen_at
  Given lead L last_seen_at = 2026-05-08
  When replay de webhook chega com event_time = 2025-12-01 → resolveLeadByAliases com options.eventTime = 2025-12-01
  Then leads.last_seen_at permanece 2026-05-08 (GREATEST guarda)

Scenario: merge canônico não regride last_seen_at do canonical
  Given lead canonical C last_seen_at = 2026-05-08
  And lead secondary S last_seen_at = 2026-04-01
  When mergeLeads com options.eventTime = 2026-04-15 (event que disparou o merge)
  Then C.last_seen_at permanece 2026-05-08
```

### Citação em código
```ts
// BR-IDENTITY-008 / INV-IDENTITY-LASTSEEN-MONOTONIC: last_seen_at é monotônico
//   GREATEST(COALESCE(current, '-infinity'::timestamptz), eventTime ?? NOW())
```
