# BR-TAGS — Regras do sistema de tags (catálogo + lead_tags + filtro)

> Consolida invariantes e comportamentos do sistema de tags entregue nas Waves 1–4 da Sprint 18 (T-TAGS-001 → T-TAGS-009). Cita invariantes já definidos em [MOD-IDENTITY § 7](../20-domain/04-mod-identity.md#7-invariantes) e adiciona regras de coordenação (rename atômico, auto-registro, bulk, filtro combinatório).
>
> Tags são **atributos binários atemporais** por lead, workspace-scoped, complementando `lead_stages` (progressão monotônica) e `events` (fatos pontuais). Conviva com duas tabelas: `lead_tags` (a tag aplicada a um lead) e `workspace_tags` (catálogo opcional de metadados — cor, descrição, soft-delete). Match entre as duas é **soft** por `(workspace_id, name)`, sem FK rígida ([ADR-047](../90-meta/04-decision-log.md#adr-047)).

---

## BR-TAGS-001 — `(workspace_id, lead_id, tag_name)` é único em `lead_tags`

### Status
Stable.

### Enunciado
Para qualquer `(workspace_id, lead_id, tag_name)` existe **no máximo uma** row em `lead_tags`. Aplicações repetidas da mesma tag ao mesmo lead são **silenciosamente idempotentes** (não viram erro, não duplicam, não bumpam `set_at` — o `set_by` original é preservado).

### Motivação
- Tags são binárias por natureza ("o lead tem a tag X ou não tem"). Duplicatas não fazem sentido semântico.
- Idempotência permite re-execução de blueprint `tag_rules` (mesmo evento processado duas vezes, mesma regra match) sem efeito colateral.
- Bulk de M leads × N tags pode legitimamente conter combinações já aplicadas — exigir que o cliente filtre antes seria custo desnecessário.

### Enforcement
- **DB:** UNIQUE index `uq_lead_tags_workspace_lead_tag (workspace_id, lead_id, tag_name)` (migration `0044`).
- **Domain:** `setLeadTag` e `bulkApplyLeadTagsByIds` usam `INSERT … ON CONFLICT (workspace_id, lead_id, tag_name) DO NOTHING`. Retorno `ok: true` mesmo quando nada foi inserido.

### Aplica-se a
MOD-IDENTITY. Equivale a [INV-LEAD-TAG-001](../20-domain/04-mod-identity.md#7-invariantes).

### Critérios de aceite

```gherkin
Scenario: aplicar a mesma tag duas vezes não duplica
  Given lead L sem tag "vip"
  When setLeadTag(L, "vip") é chamado
  And setLeadTag(L, "vip") é chamado novamente 5 minutos depois
  Then existe exatamente 1 row em lead_tags para (workspace, L, "vip")
  And o set_at da row é o do primeiro INSERT
  And o set_by da row é o do primeiro INSERT

Scenario: bulk aplica produto cartesiano com idempotência
  Given leads [A, B, C] e tags ["vip", "alta-intencao"]
  And lead A já tem "vip" aplicada por outro fluxo
  When bulkApplyLeadTagsByIds(leadIds=[A,B,C], tagNames=["vip","alta-intencao"])
  Then applied = 5  (A.alta-intencao + B.vip + B.alta-intencao + C.vip + C.alta-intencao)
  And skipped = 1   (A.vip já existia)
```

### Citação em código
```ts
// BR-TAGS-001 (INV-LEAD-TAG-001): UPSERT idempotente via UNIQUE
//   (workspace_id, lead_id, tag_name) + ON CONFLICT DO NOTHING
```

---

## BR-TAGS-002 — `lead_tags.set_by` segue formato canônico

### Status
Stable.

### Enunciado
`lead_tags.set_by` **DEVE** ser uma das formas:

| Forma | Quando | Exemplo |
|---|---|---|
| `system` | aplicação interna sem actor humano nem evento | `system` |
| `user:<uuid>` | ação manual no Control Plane | `user:f6e9...` |
| `integration:<name>` | aplicação por webhook/integração externa | `integration:guru` |
| `event:<event_name>` | aplicada por `tag_rule` do blueprint, casada em ingestion | `event:Purchase` |

Validação é **service-layer** (route ou helper); não há CHECK no DB — flexibilidade para novas fontes sem migration.

### Motivação
Proveniência de uma tag é fundamental para auditoria, debug e reversão. Sem set_by canônico:
- Não dá pra distinguir tag aplicada por bug do código vs ação consciente do operador.
- SAR/erasure não consegue separar tags derivadas de evento (recuperáveis) de tags inseridas manualmente (perda definitiva).

### Enforcement
- **Service layer:** route handlers em `apps/edge/src/routes/leads-tags.ts` derivam `setBy` do `user_id` do JWT (`user:<uuid>` quando bound; `user:dev` em fallback dev/curl). `applyTagRules` usa `event:<event_name>` automaticamente. `autoRegisterTag` chamado a partir de tag_rule passa `source='system:blueprint'`.
- **DB:** coluna `set_by text NOT NULL` (sem CHECK).

### Aplica-se a
MOD-IDENTITY. Equivale a [INV-LEAD-TAG-002](../20-domain/04-mod-identity.md#7-invariantes).

### Citação em código
```ts
// BR-TAGS-002 (INV-LEAD-TAG-002): set_by ∈ {system | user:<uuid> | integration:<name> | event:<name>}
const setBy = userId && userId !== 'dev' ? `user:${userId}` : 'user:dev';
```

---

## BR-TAGS-003 — `(workspace_id, name)` é único em `workspace_tags`; auto-registro é idempotente

### Status
Stable ([ADR-047](../90-meta/04-decision-log.md#adr-047)).

### Enunciado
Catálogo `workspace_tags` é **único por nome dentro de cada workspace**. Toda escrita no catálogo via `autoRegisterTag` usa `ON CONFLICT (workspace_id, name) DO NOTHING` — chamadas repetidas com mesmo `(workspace, name)` **não falham**, **não duplicam** e **NÃO modificam** o `created_by` da row existente.

`createTag` (ação manual do operador) sinaliza o conflito como `error: 'duplicate'` → HTTP `409 duplicate_tag` para a UI exibir feedback claro.

### Motivação
- Catálogo é fonte de metadados de UI (cor, descrição). Duas rows para o mesmo nome causariam ambiguidade no chip da tag.
- Auto-registro precisa ser idempotente porque é chamado em hot-paths:
  - `applyTagRules` (cada evento processado pode disparar N tag_rules).
  - `setLeadTag` chamado pelo route handler (cada bulk-apply chama N vezes).
- Distinção entre auto-register (silencioso) e create-manual (com feedback) é UX, não correctness.

### Enforcement
- **DB:** UNIQUE index `uq_workspace_tags_workspace_name (workspace_id, name)` (migration `0053`).
- **Domain:** `autoRegisterTag` → `ON CONFLICT DO NOTHING`. `createTag` → captura `23505` e retorna `error: 'duplicate'`.

### Aplica-se a
MOD-IDENTITY. Equivale a [INV-WORKSPACE-TAG-001](../20-domain/04-mod-identity.md#7-invariantes).

### Critérios de aceite

```gherkin
Scenario: auto-registro idempotente preserva created_by original
  Given workspace W sem tag "vip" no catálogo
  When autoRegisterTag(W, "vip", source="system:blueprint")
  Then row criada com created_by = "system:blueprint"
  When autoRegisterTag(W, "vip", source="user:abc-123") 1h depois
  Then created_by da row continua "system:blueprint"
  And nenhuma row duplicada

Scenario: createTag manual em conflito devolve 409
  Given catálogo já tem "vip" registrada
  When POST /v1/workspace-tags { name: "vip" }
  Then HTTP 409 com code = "duplicate_tag"
```

### Citação em código
```ts
// BR-TAGS-003 (INV-WORKSPACE-TAG-001): ON CONFLICT DO NOTHING — idempotent auto-register
INSERT INTO workspace_tags (...) VALUES (...) ON CONFLICT (workspace_id, name) DO NOTHING
```

---

## BR-TAGS-004 — `workspace_tags.created_by` segue formato canônico

### Status
Stable.

### Enunciado
`workspace_tags.created_by` **DEVE** ser uma das formas:

| Forma | Quando |
|---|---|
| `user:<uuid>` | tag criada manualmente pelo operador no /settings/tags |
| `system:auto-registered` | tag aplicada pela primeira vez ao lead via `setLeadTag` (route handler manual sem blueprint match) |
| `system:blueprint` | tag aplicada pela primeira vez via `applyTagRules` durante ingestion |

Validação é service-layer (mesmo padrão de [BR-TAGS-002](#br-tags-002)).

### Motivação
`created_by` é a única pista de "como essa tag chegou ao catálogo". Crítico para responder a perguntas como "essa tag foi cadastrada via UI ou auto-registrada por um blueprint?" sem ler `audit_log`.

### Enforcement
Service layer em `apps/edge/src/lib/workspace-tags.ts` (`autoRegisterTag` aceita só os 3 valores via type literal) + `apps/edge/src/routes/workspace-tags.ts` (`createTag` constrói `user:<uuid>` a partir do JWT).

### Aplica-se a
MOD-IDENTITY. Equivale a [INV-WORKSPACE-TAG-002](../20-domain/04-mod-identity.md#7-invariantes).

### Citação em código
```ts
// BR-TAGS-004 (INV-WORKSPACE-TAG-002): created_by ∈ {user:<uuid> | system:auto-registered | system:blueprint}
```

---

## BR-TAGS-005 — Rename de tag é atômico em transação

### Status
Stable.

### Enunciado
`updateTag({ patch: { name: newName } })` **DEVE** executar em **uma única transação Postgres**:

1. `SELECT … FOR UPDATE` na row do `workspace_tags` para travar a tag durante o rename.
2. `UPDATE workspace_tags SET name = newName WHERE id = ? AND workspace_id = ?`.
3. Se `oldName !== newName`: `UPDATE lead_tags SET tag_name = newName WHERE workspace_id = ? AND tag_name = oldName`.

A transação **DEVE rollback** quando o novo nome colide com outra tag existente no mesmo workspace (UNIQUE violation no passo 2 — vira `error: 'duplicate'`).

### Motivação
Match `workspace_tags ↔ lead_tags` é soft (sem FK — [INV-WORKSPACE-TAG-003](../20-domain/04-mod-identity.md#7-invariantes), [ADR-047](../90-meta/04-decision-log.md#adr-047)). Sem rename atômico:
- Janela entre os dois UPDATEs deixaria leads exibindo o nome antigo da tag (chip órfão).
- Falha no segundo UPDATE deixaria o catálogo divergente das aplicações.
- Mais grave: uma leitura concorrente durante a janela veria estado inconsistente.

A transação garante "all-or-nothing": ou ambos os UPDATEs comitam, ou ambos revertem.

### Enforcement
- **Domain:** `updateTag` em `apps/edge/src/lib/workspace-tags.ts` envolve os 2 UPDATEs em `db.transaction(async (tx) => { … })`.
- **Lock:** `SELECT … FOR UPDATE` previne update concorrente que entraria em race com o nosso.
- **Workspace isolation:** `WHERE workspace_id = ?` em **ambos** os UPDATEs (cross-workspace leak prohibited mesmo dentro da transação).

### Aplica-se a
MOD-IDENTITY. Coordenação direta de [INV-WORKSPACE-TAG-003](../20-domain/04-mod-identity.md#7-invariantes).

### Critérios de aceite

```gherkin
Scenario: rename propaga em lead_tags atomicamente
  Given catálogo tem "vip" e leads [A, B] com tag "vip"
  When PATCH /v1/workspace-tags/:id { name: "premium" }
  Then workspace_tags.name = "premium"
  And lead_tags.tag_name = "premium" para A e B
  And tudo no mesmo commit (visível só após COMMIT)

Scenario: rename para nome conflitante faz rollback
  Given catálogo tem "vip" e "premium"; lead A tem "vip"
  When PATCH /v1/workspace-tags/:id_da_vip { name: "premium" }
  Then HTTP 409 duplicate_tag
  And workspace_tags.name continua "vip"
  And lead A.tag_name continua "vip"
  And nenhum estado parcial visível

Scenario: rename para mesmo nome é no-op em lead_tags
  Given catálogo tem "vip"
  When PATCH /v1/workspace-tags/:id { name: "vip", color: "#ff0000" }
  Then workspace_tags.color atualizado
  And UPDATE em lead_tags é SKIPPED (oldName === newName)
```

### Citação em código
```ts
// BR-TAGS-005: rename atômico — workspace_tags + lead_tags na mesma transação
await args.db.transaction(async (tx) => { /* SELECT FOR UPDATE, UPDATE wt, UPDATE lt */ });
```

---

## BR-TAGS-006 — `archiveTag` é soft-delete com cascade opcional

### Status
Stable.

### Enunciado
`archiveTag({ cascade })` opera em transação:

- **Sempre:** `UPDATE workspace_tags SET archived_at = NOW() WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`. Tag arquivada **NÃO** é removida do catálogo — apenas oculta de listagens default (`include_archived=false`).
- **Quando `cascade=true`:** `DELETE FROM lead_tags WHERE workspace_id = ? AND tag_name = nome_da_tag` na **mesma transação**.
- **Quando `cascade=false`** (default): lead_tags com mesmo nome **permanecem** (relação soft — chips continuam visíveis até que operador faça unset manual ou rename).

`unarchiveTag` zera `archived_at` para `NULL` (reversão).

### Motivação
Operadores precisam de dois fluxos:
1. **"Não quero mais ver essa tag no picker"** — soft-archive (cascade=false): chips em leads ficam, picker oculta.
2. **"Quero remover essa tag de todo mundo"** — hard cleanup (cascade=true): lead_tags morre, mas catálogo fica arquivado (não deletado) para auditoria.

Sem cascade=true em transação: operador rodaria archive + manual bulk-remove em janela aberta — risco de estado parcial visível.

### Enforcement
- **Domain:** `archiveTag` em `apps/edge/src/lib/workspace-tags.ts`. Ambos os passos dentro de `db.transaction`.
- **Route:** `DELETE /v1/workspace-tags/:id { cascade?: boolean }` (body opcional; cascade default `false`).

### Aplica-se a
MOD-IDENTITY.

### Critérios de aceite

```gherkin
Scenario: archive sem cascade preserva lead_tags
  Given catálogo tem "vip"; leads [A, B] com "vip"
  When DELETE /v1/workspace-tags/:id { cascade: false }
  Then workspace_tags.archived_at = NOW()
  And lead_tags de A e B continuam intactas
  And listagem default (include_archived=false) não mostra "vip"

Scenario: archive com cascade remove lead_tags na mesma transação
  Given catálogo tem "vip"; leads [A, B] com "vip"
  When DELETE /v1/workspace-tags/:id { cascade: true }
  Then workspace_tags.archived_at = NOW()
  And lead_tags de A e B foram DELETADAS
  And cascaded = 2 na response
  And tudo no mesmo commit

Scenario: archive de tag já arquivada é no-op idempotente
  When DELETE /v1/workspace-tags/:id { cascade: false }   (segunda vez)
  Then HTTP 200 com archived = false (nada mudou)
  And audit_log NÃO recebe nova entry
```

---

## BR-TAGS-007 — Bulk apply/remove por seleção de leads tem cap de 5000 × 50

### Status
Stable.

### Enunciado
Endpoints bulk (`POST /v1/leads-tags/bulk-apply`, `POST /v1/leads-tags/bulk-remove`) **DEVEM** rejeitar payloads que excedam:

- `lead_public_ids`: até **5000** UUIDs por request.
- `tag_names`: até **50** nomes por request.

Produto cartesiano máximo = 250 000 combinações por request. `lead_public_ids` desconhecidos (não pertencem ao workspace ou não existem) são **reportados na response** em `unknown_public_ids[]`, **não causam erro** — UX idempotente: o caller pode reprocessar com o restante.

### Motivação
- Cap protege contra payload bomba (request com 1M IDs trava o Worker).
- Reporting de unknowns em vez de fail-fast é UX-friendly para o operador rodando bulk em seleção pré-filtrada que pode conter rows recém-deletadas.
- 5000 cobre o caso real "selecionar tudo na lista de contatos" (página default mostra ≤100 mas o "Selecionar todos os X resultados" pode bater 5000).

### Enforcement
- **Edge:** Zod schemas em `apps/edge/src/routes/leads-tags.ts`:
  - `tag_names: z.array(TagNameSchema).min(1).max(50)`.
  - `lead_public_ids: z.array(z.string().uuid()).min(1).max(5000)`.
- **Domain:** `bulkApplyLeadTagsByIds` / `bulkUnsetLeadTagsByIds` em `apps/edge/src/lib/lead-tags.ts` usam `unnest(uuid[])` × `unnest(text[])` para uma única INSERT/DELETE — sem loop de N round-trips.
- **Resolução de unknowns:** SELECT em `leads` com `id = ANY(::uuid[])` em uma só round-trip; diferença com input é reportada.

### Aplica-se a
MOD-IDENTITY.

### Critérios de aceite

```gherkin
Scenario: bulk além do cap é rejeitado
  When POST /v1/leads-tags/bulk-apply com 5001 lead_public_ids
  Then HTTP 400 validation_error

Scenario: lead_public_ids desconhecidos são reportados, não falham
  Given lead_public_ids = [A_real, X_não_existe, Y_outro_workspace]
  When POST /v1/leads-tags/bulk-apply { lead_public_ids, tag_names: ["vip"] }
  Then HTTP 200
  And response.applied = 1   (apenas A_real ganhou "vip")
  And response.unknown_public_ids = [X_não_existe, Y_outro_workspace]
```

---

## BR-TAGS-008 — Filtro de tags na lista de leads usa EXISTS, nunca JOIN

### Status
Stable.

### Enunciado
Toda query SQL da lista/count/export de leads que filtra por presença ou ausência de tags **DEVE** usar `EXISTS (…) / NOT EXISTS (…)` correlacionados — **nunca** `INNER JOIN lead_tags`.

Combinador é declarativo:

```ts
type TagFilter = {
  op: 'and' | 'or';
  clauses: Array<{ has: boolean; tag: string }>;
};
```

- `op: 'and'` — todas as clauses precisam ser satisfeitas.
- `op: 'or'` — pelo menos uma clause precisa ser satisfeita.
- `has: true` — `EXISTS (SELECT 1 FROM lead_tags WHERE …)`.
- `has: false` — `NOT EXISTS (SELECT 1 FROM lead_tags WHERE …)`.

Cada subquery EXISTS **DEVE** ancorar `workspace_id` explicitamente (não confiar em RLS para queries aninhadas) — [BR-IDENTITY-001](BR-IDENTITY.md#br-identity-001) / [BR-PRIVACY-001](BR-PRIVACY.md).

### Motivação
JOIN em `lead_tags` **multiplica** cada lead pelo número de tags que ele possui, inflando contagem total e quebrando paginação keyset. Este é o mesmo bug pattern documentado em MEMORY.md como "Join multiplication bug (lead_attributions)" — corrigido em 2026-05-18 com subquery `WHERE id IN (…)` na rota `/v1/leads`. EXISTS é a forma canônica para "lead que tem a tag X" sem multiplicação.

### Enforcement
- **Domain:** `buildTagFilterWhere` em `apps/edge/src/lib/leads-filter.ts` é o **único** lugar que constrói o fragmento SQL — caller passa `tagFilter` opcional em `ListLeadsOpts`/`CountLeadsOpts`/`ExportLeadsOpts`.
- **DB:** subqueries são parametrizadas (`${workspaceId}::uuid` + `${cl.tag}`); zero string interpolation.
- **Cap:** Zod schema do route handler limita `clauses.max(20)` para evitar fan-out patológico de subqueries.

### Aplica-se a
MOD-IDENTITY. Usado por endpoints `GET /v1/leads`, `POST /v1/leads/export`, e contagens de UI.

### Critérios de aceite

```gherkin
Scenario: filtro AND com "possui" e "não-possui"
  Given filter = { op: 'and', clauses: [
    { has: true,  tag: "vip" },
    { has: false, tag: "frio" }
  ]}
  Then SQL gerado é:
    EXISTS (SELECT 1 FROM lead_tags WHERE lead_id = leads.id AND workspace_id = $1 AND tag_name = 'vip')
    AND NOT EXISTS (SELECT 1 FROM lead_tags WHERE lead_id = leads.id AND workspace_id = $1 AND tag_name = 'frio')
  And total filtrado conta cada lead 1x (sem multiplicação)

Scenario: filtro OR retorna união
  Given filter = { op: 'or', clauses: [
    { has: true, tag: "vip" },
    { has: true, tag: "alta-intencao" }
  ]}
  Then total = COUNT(distinct lead) com tag em pelo menos uma das duas
  And paginação keyset funciona (não há duplicatas)

Scenario: filtro vazio é no-op
  Given filter.clauses = []
  Then buildTagFilterWhere retorna null
  And caller pula o push no array de WHEREs (sem 1=1 espúrio)
```

### Citação em código
```ts
// BR-TAGS-008: EXISTS/NOT EXISTS — NUNCA INNER JOIN (join multiplication bug)
const inner = sql`SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${idCol} AND lead_tags.workspace_id = ${workspaceId}::uuid AND lead_tags.tag_name = ${cl.tag}`;
return cl.has ? sql`EXISTS (${inner})` : sql`NOT EXISTS (${inner})`;
```

---

## BR-TAGS-009 — `tag_filter` na URL usa base64url(JSON) e erros viram `invalid_tag_filter`

### Status
Stable.

### Enunciado
`GET /v1/leads` aceita query param `tag_filter` no formato:

```
tag_filter = base64url( JSON.stringify({ op, clauses }) )
```

Onde o JSON decodificado **DEVE** validar contra:

```ts
{
  op: 'and' | 'or',              // default 'and' quando ausente
  clauses: Array<{               // min 1, max 20
    has: boolean,
    tag: string                  // min 1, max 120 chars
  }>
}
```

Qualquer falha — `tag_filter` mal formado (base64 inválido), JSON parse error, ou Zod schema violation — **DEVE** colapsar em um único erro:

```http
HTTP 400
{ "code": "invalid_tag_filter", "request_id": "…" }
```

Mensagens de erro **NÃO PODEM** vazar detalhes do payload (BR-PRIVACY-001) — caller fica com uma única decisão: "consertar e reenviar".

### Motivação
- `tag_filter` como query string JSON puro seria fragilizado por URL-encoding de chaves/aspas. base64url contorna isso sem custo significativo.
- Colapsar todos os erros num só code reduz superfície de ataque (não dá pra inferir o schema interno tentando diferentes payloads ruins).
- Cap de 20 clauses no Zod alinha com [BR-TAGS-008](#br-tags-008) (proteção contra fan-out).

### Enforcement
- **Edge:** handler `GET /v1/leads` em `apps/edge/src/routes/leads-timeline.ts`:
  1. `c.req.query('tag_filter')` — string crua.
  2. `base64UrlDecode(raw)` → UTF-8.
  3. `JSON.parse` → objeto.
  4. `TagFilterSchema.parse` (Zod) → validação estrita.
  5. Qualquer throw vira `c.json({ code: 'invalid_tag_filter', request_id }, 400)`.
- **Domain:** o objeto validado é passado para `listLeads`/`countLeads` via `opts.tagFilter` (mesmo shape do `buildTagFilterWhere`).

### Aplica-se a
MOD-IDENTITY. Endpoint `GET /v1/leads`.

### Critérios de aceite

```gherkin
Scenario: tag_filter válido aplica EXISTS
  Given tag_filter = base64url(JSON.stringify({ op:'and', clauses:[{has:true,tag:'vip'}] }))
  When GET /v1/leads?tag_filter=<base64url>
  Then HTTP 200, items só com leads que possuem "vip"

Scenario: tag_filter com base64 inválido vira 400
  When GET /v1/leads?tag_filter=!!!notbase64!!!
  Then HTTP 400 { code: "invalid_tag_filter" }

Scenario: tag_filter com JSON válido mas schema inválido vira 400
  Given tag_filter = base64url(JSON.stringify({ op:'xor', clauses:[] }))
  When GET /v1/leads?tag_filter=<base64url>
  Then HTTP 400 { code: "invalid_tag_filter" }

Scenario: tag_filter ausente é no-op (não 400)
  When GET /v1/leads (sem tag_filter)
  Then HTTP 200, lista sem filtro de tag

Scenario: clauses > 20 vira 400
  Given clauses com 21 entradas
  Then HTTP 400 { code: "invalid_tag_filter" }
```

### Citação em código
```ts
// BR-TAGS-009: tag_filter wire-format = base64url(JSON({op, clauses}));
//   qualquer falha (base64/JSON/Zod) colapsa em 400 invalid_tag_filter
try {
  const decoded = base64UrlDecode(rawTagFilter);
  parsedTagFilter = TagFilterSchema.parse(JSON.parse(decoded));
} catch {
  return c.json({ code: 'invalid_tag_filter', request_id: requestId }, 400);
}
```

---

## BR-TAGS-010 — Ações manuais usam `user:<uuid>` canônico para set_by e created_by

### Status
Stable.

### Enunciado
Toda mutação manual originada do Control Plane (operador autenticado via JWT Supabase) **DEVE** derivar a proveniência diretamente do `user_id` do JWT:

- `lead_tags.set_by = "user:" + user_id` (quando bound via `workspace_members`).
- `workspace_tags.created_by = "user:" + user_id` (quando criada via `POST /v1/workspace-tags`).
- Fallback `"user:dev"` aceito **apenas** quando `user_id === "dev"` (path de DEV_WORKSPACE_ID bypass para curl local).

`audit_log.actor_id` segue o mesmo `user_id` (com fallback literal `"cp_user"` para audit-best-effort quando JWT user-id ausente).

### Motivação
- Sem `user:<uuid>` consistente, audit log fica órfão: dá pra dizer "tag aplicada" mas não "por quem".
- ADR de boundaries inter-módulo: identidade do actor é responsabilidade do route handler, não do helper de domínio. Service layer ([lead-tags.ts](../../apps/edge/src/lib/lead-tags.ts), [workspace-tags.ts](../../apps/edge/src/lib/workspace-tags.ts)) aceita string genérica para flexibilidade; rota canoniza.

### Enforcement
- **Route layer:** `apps/edge/src/routes/leads-tags.ts` e `apps/edge/src/routes/workspace-tags.ts` lêem `c.get('user_id')` e constroem `user:<uuid>` antes de chamar o helper.
- **Test:** unit teste no route layer cobre o caso `user_id = dev` (fallback) e `user_id = uuid real`.

### Aplica-se a
MOD-IDENTITY, MOD-AUDIT. Coordena com [BR-TAGS-002](#br-tags-002) e [BR-TAGS-004](#br-tags-004).

### Citação em código
```ts
// BR-TAGS-010: ações manuais derivam set_by/created_by do user_id do JWT
const userId = c.get('user_id') as string | undefined;
const setBy = userId && userId !== 'dev' ? `user:${userId}` : 'user:dev';
```

---

## Resumo de invariantes citados

| INV | Origem canônica | Citado em BR-TAGS |
|---|---|---|
| INV-LEAD-TAG-001 | [MOD-IDENTITY § 7](../20-domain/04-mod-identity.md#7-invariantes) | BR-TAGS-001 |
| INV-LEAD-TAG-002 | [MOD-IDENTITY § 7](../20-domain/04-mod-identity.md#7-invariantes) | BR-TAGS-002 |
| INV-WORKSPACE-TAG-001 | [MOD-IDENTITY § 7](../20-domain/04-mod-identity.md#7-invariantes) | BR-TAGS-003 |
| INV-WORKSPACE-TAG-002 | [MOD-IDENTITY § 7](../20-domain/04-mod-identity.md#7-invariantes) | BR-TAGS-004 |
| INV-WORKSPACE-TAG-003 | [MOD-IDENTITY § 7](../20-domain/04-mod-identity.md#7-invariantes) | BR-TAGS-005, BR-TAGS-006 |

## ADRs relacionados

- [ADR-047](../90-meta/04-decision-log.md#adr-047) — Relação `workspace_tags ↔ lead_tags` é soft (sem FK rígida).

## Ownership de código

| Path | BR |
|---|---|
| `apps/edge/src/lib/lead-tags.ts` | BR-TAGS-001/002/010 |
| `apps/edge/src/lib/workspace-tags.ts` | BR-TAGS-003/004/005/006/010 |
| `apps/edge/src/lib/leads-filter.ts` | BR-TAGS-008 |
| `apps/edge/src/lib/leads-queries.ts` | BR-TAGS-008 (consumidor) |
| `apps/edge/src/routes/workspace-tags.ts` | BR-TAGS-003/004/005/006/010 |
| `apps/edge/src/routes/leads-tags.ts` | BR-TAGS-001/002/007/010 |
| `apps/edge/src/routes/leads-timeline.ts` (GET /v1/leads) | BR-TAGS-008/009 |
| `packages/db/migrations/0053_workspace_tags.sql` | BR-TAGS-003/004 (DDL) |
| `packages/db/migrations/0044_lead_tags.sql` | BR-TAGS-001/002 (DDL — Sprint 16) |
| `packages/db/src/schema/workspace_tag.ts` | BR-TAGS-003/004 (Drizzle schema) |
| `packages/db/src/schema/lead_tag.ts` | BR-TAGS-001/002 (Drizzle schema — Sprint 16) |
