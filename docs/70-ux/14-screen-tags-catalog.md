# 14 — SCREEN: Catálogo de Tags (`/settings/tags`)

> **Status:** Sprint 18 (T-TAGS-006). UI canônica do catálogo `workspace_tags`. Espelhada em `apps/control-plane/src/app/(app)/settings/tags/`.

## Propósito

Tela central para o operador gerenciar **metadados** do catálogo de tags do workspace:

- Listar tags ativas + arquivadas (toggle).
- Criar nova tag com nome + cor + descrição.
- Editar tag existente (nome, cor, descrição) — **rename é atômico** e propaga em `lead_tags.tag_name` (BR-TAGS-005).
- Arquivar (soft-delete) com opção de cascade hard-delete em `lead_tags` (BR-TAGS-006).
- Reativar tag arquivada.

Tags são **operator-defined** (texto livre). O catálogo é **opcional** — `lead_tags.tag_name` pode existir sem row correspondente em `workspace_tags` (ADR-047, relação soft).

## Rota

`/settings/tags` — sub-rota de Settings.

## AUTHZ

| Ação | OWNER | ADMIN | MARKETER | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| Listar | ✓ | ✓ | ✓ | ✓ | ✓ |
| Criar | ✓ | ✓ | ✓ | ✓ | ✗ |
| Editar | ✓ | ✓ | ✓ | ✓ | ✗ |
| Arquivar/Reativar | ✓ | ✓ | ✓ | ✓ | ✗ |
| Arquivar com `cascade=true` | ✓ | ✓ | ✗ | ✗ | ✗ |

> **Wave 2B atual:** qualquer role autenticada passa nos route handlers (`required: false` no middleware mantém DEV bypass). Refinamento por role acima é o alvo do Wave 3 — registrar como OQ se sair desta versão.

## 1. Layout (wireframe)

```
Settings ▸ Tags

┌─────────────────────────────────────────────────────────────────┐
│  Tags do workspace                            [+ Nova tag]      │
│                                                                  │
│  [ Buscar tags... ]                  ☐ Mostrar arquivadas        │
│                                                                  │
│  ╔═══════╤══════════════╤══════════╤═══════╤══════════════════╗ │
│  ║ Cor   │ Nome         │ Descrição│ Leads │ Ações            ║ │
│  ╠═══════╪══════════════╪══════════╪═══════╪══════════════════╣ │
│  ║ ● red │ vip          │ ICP A    │ 87    │ ✏ Editar │ 🗑    ║ │
│  ║ ● blue│ alta-intenção│ ...      │ 42    │ ✏ Editar │ 🗑    ║ │
│  ║ —     │ frio         │ —        │ 12    │ ✏ Editar │ 🗑    ║ │
│  ╚═══════╧══════════════╧══════════╧═══════╧══════════════════╝ │
│                                                                  │
│  3 tags ativas                                                   │
└─────────────────────────────────────────────────────────────────┘

[ Drawer "Editar tag" lateral ao clicar em ✏ ]
[ AlertDialog "Arquivar tag?" ao clicar em 🗑 ]
```

## 2. Componentes

- **TagChip** (`components/tags/TagChip.tsx`) — preview de cor consistente; aceita `variant ∈ {default, has, missing}` e `size ∈ {sm, md}`.
- **Tabela** — shadcn `Table` (sortable; default por `name ASC`).
- **Drawer de edição** — shadcn `Sheet` (lateral direita).
- **AlertDialog de archive** — shadcn `AlertDialog` (double-confirm; checkbox "Remover de todos os leads (cascade)" desmarcado por default).
- **Color picker** — input `<input type="color">` nativo + parser hex 6 chars; valor `null` aceito (sem cor → chip cinza).

## 3. Estados

| Estado | Renderização |
|---|---|
| **Empty (catálogo vazio + sem `lead_tags`)** | Card central: "Nenhuma tag ainda. Crie a primeira ou cadastre `tag_rules` no blueprint para auto-registro." Botão `[+ Nova tag]`. |
| **Empty (catálogo vazio mas `lead_tags` populado)** | Banner amarelo: "X tags em uso sem cadastro no catálogo. Auto-registro acontece na próxima ingestion ou ação manual." Lista vazia. |
| **Loading** | Skeleton de 5 linhas. |
| **Search empty** | "Nenhuma tag bate com `<query>`." |
| **Erro de fetch** | Card vermelho com mensagem genérica + botão "Tentar novamente". |
| **Mutação em progresso** | Botão "Salvar"/"Arquivar" com `Loader2` spinner + `disabled`. |
| **Mutação em erro de duplicate** | Toast vermelho "Já existe uma tag com esse nome." (BR-TAGS-003 / `409 duplicate_tag`). |

## 4. Ações → endpoints

| Ação | Verb + path | Body | BR aplicada |
|---|---|---|---|
| Listar | `GET /v1/workspace-tags?with_count=true&include_archived={bool}` | — | BR-TAGS-003 |
| Criar | `POST /v1/workspace-tags` | `{ name, color?, description? }` | BR-TAGS-003/004/010 |
| Editar | `PATCH /v1/workspace-tags/:id` | `{ name?, color?, description? }` | BR-TAGS-005 (rename atômico) |
| Arquivar | `DELETE /v1/workspace-tags/:id` | `{ cascade?: boolean }` | BR-TAGS-006 |
| Reativar | `POST /v1/workspace-tags/:id/unarchive` | — | BR-TAGS-003 |

## 5. Validação (front-end + back-end)

- `name`: 1–120 chars, trimmed; preview ao vivo no chip antes do submit. Espaços excessivos colapsados.
- `color`: hex `#rrggbb` ou `null`. Sem validação de paleta — preview do chip dá feedback.
- `description`: 0–500 chars.
- Conflito de nome → mensagem inline no campo `name` ("Já existe uma tag com este nome no workspace") + foco no input.

## 6. Cascade UX

AlertDialog de archive tem **dois caminhos**:

```
Arquivar "vip"?

[ ] Remover de todos os leads (irreversível para os leads)
    └ 87 leads serão limpos. A tag continuará no catálogo (arquivada).

[Cancelar]                                  [Arquivar]
```

- Default: checkbox **desmarcada** (BR-TAGS-006 padrão — soft-archive preserva `lead_tags`).
- Marcada: AlertDialog troca o botão para `Arquivar e remover (irreversível)` em vermelho.
- Após arquivar: toast verde com link "Reativar agora" (undo de 10s sem confirmação).

## 7. BRs aplicadas

- BR-TAGS-003 (UNIQUE catalog + duplicate UX)
- BR-TAGS-004 (`created_by = "user:<uuid>"`)
- BR-TAGS-005 (rename atômico — espera de transação OK)
- BR-TAGS-006 (archive + cascade opcional)
- BR-TAGS-010 (`set_by`/`created_by` derivados do JWT)
- BR-AUDIT-001 (toda mutação grava `audit_log`)
- BR-IDENTITY-006 (PII fora desta tela — apenas metadados)

## 8. A11y

- Tabela com `<caption>` "Tags do workspace, N ativas".
- Todo `<button>` tem `aria-label` descritivo.
- Drawer captura foco e restaura para o `<button>` que abriu.
- AlertDialog tem `role="alertdialog"` + descrição completa via `aria-describedby`.
- Search input com `<label>` visível.

---

# 14 — Pattern adicional: Tags em `/contatos` (lista + detalhe)

> Componentes reutilizados em duas telas existentes.

## Lista `/contatos` — filtro combinatório + bulk

UI: `apps/control-plane/src/app/(app)/contatos/page.tsx`.

### Filtro de tags (TagFilterBuilder)

Componente `components/tags/TagFilterBuilder.tsx`. Renderizado no header da lista, abaixo dos filtros existentes (q/launch/lifecycle).

```
Tags:  ( E ▾ )  [● vip   ✕]  [○ frio   ✕]  [+ adicionar cláusula]
```

- Toggle `E / OU` à esquerda escolhe combinador (`op: 'and' | 'or'`).
- Cada chip representa uma **clause** `{ has, tag }`:
  - `●` (filled) = `has: true` (possui).
  - `○` (outline) = `has: false` (não possui). Click no símbolo flipa.
- `[+ adicionar cláusula]` abre `SingleTagCombobox` (autocomplete sobre `availableTags` carregada via `useWorkspaceTags`).
- Cap de 20 cláusulas (BR-TAGS-009).
- Estado serializado na URL via query param `tag_filter` (wire format: `base64url(JSON.stringify({ op, clauses }))`).

### Bulk apply/remove

Quando ≥1 lead está selecionado, surge barra de bulk-actions:

```
[N leads selecionados]
[Aplicar tags...] [Remover tags...] [Exportar CSV] [Arquivar] [Excluir]
```

- "Aplicar tags..." abre Sheet com `TagPicker` (multi-select com autocomplete + criação inline). Submit → `POST /v1/leads-tags/bulk-apply { lead_public_ids, tag_names }`. Toast resume `applied`/`skipped`/`unknown_public_ids.length`.
- "Remover tags..." espelha o fluxo → `POST /v1/leads-tags/bulk-remove`.
- Cap visual: caso a seleção exceda 5000 (BR-TAGS-007), o submit é desabilitado com tooltip "Limite de 5000 contatos por ação".

### Estados

- **Filtro vazio**: nenhum chip; `tag_filter` ausente da URL; lista mostra todos os leads.
- **Filtro com 1+ cláusula**: chip "Filtro de tag: N cláusula(s)" no resumo de filtros aplicados; botão `[× limpar filtros]` zera tudo.
- **`invalid_tag_filter` recebido do backend** (BR-TAGS-009): toast vermelho "Filtro de tag inválido. Tente novamente." + remove `tag_filter` da URL.

## Detalhe `/contatos/[lead_public_id]` — TagPicker inline

UI: `apps/control-plane/src/app/(app)/contatos/[lead_public_id]/lead-summary-header.tsx`.

### Seção "Tags" no LeadSummaryHeader

```
Tags: [vip ×] [alta-intencao ×] [+ adicionar]
```

- Cada chip mostra `tag_name` (cor do catálogo quando match soft existe; tooltip com `set_by` + `set_at`).
- `×` no chip dispara `DELETE /v1/leads-tags/by-lead/:lead_public_id/:tag_name` (otimistic update; toast em erro).
- `[+ adicionar]` abre `TagPicker` (autocomplete sobre `useWorkspaceTags` + criação inline se tag não existe no catálogo).
- Submit do picker dispara `POST /v1/leads-tags/by-lead/:lead_public_id { tag_names }` (idempotente).

### Provenance display

Tooltip de cada chip mostra:

```
"vip"
Aplicada por: você (2026-05-18 14:32)
Origem: ação manual
```

Mapeamento `set_by` → texto:
- `user:<uuid>` → "você" (quando uuid == jwt.user_id) ou o display name resolvido.
- `event:<event_name>` → "evento `<event_name>`".
- `integration:<name>` → "integração `<name>`".
- `system` → "sistema".

## BRs aplicadas (ambas as telas)

- BR-TAGS-007 (caps 5000 × 50 honrados pela UI)
- BR-TAGS-008 (filtro EXISTS — implementação no backend; UI só constrói o objeto)
- BR-TAGS-009 (encoding `tag_filter` na URL)
- BR-TAGS-010 (provenance UI)

## Ownership de UI

- `apps/control-plane/src/app/(app)/settings/tags/page.tsx` + `tags-client.tsx` — tela /settings/tags.
- `apps/control-plane/src/components/tags/TagChip.tsx` — chip canônico (variant has/missing/default).
- `apps/control-plane/src/components/tags/TagPicker.tsx` — multi-select com autocomplete + criação inline.
- `apps/control-plane/src/components/tags/TagFilterBuilder.tsx` — builder de filtro combinatório (E/OU, possui/não-possui).
- `apps/control-plane/src/components/tags/use-workspace-tags.ts` — fetcher canônico (`with_count=true`, cache compartilhado).
- `apps/control-plane/src/components/tags/types.ts` — re-exports tipados (`WorkspaceTag`, `TagFilterValue`, etc.).
- `apps/control-plane/src/app/(app)/contatos/page.tsx` — lista + bulk + filtro.
- `apps/control-plane/src/app/(app)/contatos/[lead_public_id]/lead-summary-header.tsx` — chips + picker inline.
