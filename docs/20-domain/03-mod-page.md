# MOD-PAGE — Páginas e page tokens

## 1. Identidade

- **ID:** MOD-PAGE
- **Tipo:** Core
- **Dono conceitual:** MARKETER (config) + OPERATOR (rotation de tokens)

## 2. Escopo

### Dentro
- Pages com `public_id`, role (`capture`/`sales`/`thankyou`/`webinar`/`checkout`/`survey`), integration_mode (`a_system`/`b_snippet`/`c_webhook`), `allowed_domains`, `event_config`.
- PageTokens com hash, status (`active`/`rotating`/`revoked`), rotação com janela de overlap (ADR-023).
- Validação de origem (CORS) e binding de page_token a page específica.

### Fora
- Servir HTML da página (em modo `a_system` é responsabilidade de `apps/lp-templates/`, Fase 5).
- Eventos disparados pela página (`MOD-EVENT`).

## 3. Entidades

### Page
- `id`
- `workspace_id`
- `launch_id`
- `public_id` (único por launch)
- `role`
- `integration_mode`
- `url` (informativo, opcional)
- `allowed_domains` (array — multi-domain ok)
- `event_config` (jsonb — schema declarativo de eventos a capturar)
- `variant` (A/B testing, opcional)
- `status` (`active`/`paused`/`archived`)
- `created_at`, `updated_at`

### PageToken
- `id`
- `workspace_id`
- `page_id`
- `token_hash` (SHA-256 do segredo emitido — input exato: `TextEncoder('utf-8').encode(tokenHexString)`, onde `tokenHexString` é a representação hex-string dos 32 bytes aleatórios gerados; hash e validação usam o mesmo input)
- `label` (humano, ex.: "v1 — produção")
- `status` (`active` / `rotating` / `revoked`)
- `created_at`, `rotated_at`, `revoked_at`

## 4. Relações

- `Page N—1 Launch` (e via Launch, N—1 Workspace)
- `Page 1—N PageToken`
- `Page 1—N Event` (via `events.page_id`)

## 5. Estados

### Page
```
[draft] → [active] ↔ [paused] → [archived]
```

### PageToken
```
[active] → [rotating] → [revoked]
       ↓
   [revoked] (revogação imediata sem janela)
```

## 6. Transições válidas

### Page
| De | Para | Quem |
|---|---|---|
| `draft` | `active` | MARKETER, ADMIN |
| `active` | `paused` | MARKETER, ADMIN |
| `paused` | `active` | MARKETER, ADMIN |
| qualquer | `archived` | ADMIN |

### PageToken
| De | Para | Quem | Notas |
|---|---|---|---|
| (criação) | `active` | OPERATOR, ADMIN | Token claro retornado uma única vez. |
| `active` | `rotating` | OPERATOR, ADMIN | Cria novo `active` em paralelo; antigo aceita por janela `PAGE_TOKEN_ROTATION_OVERLAP_DAYS` (default 14d). |
| `rotating` | `revoked` | sistema (após janela) | Automático. |
| `active` | `revoked` | OPERATOR, ADMIN | Bypass da janela — emergência de segurança. |

### Persistência do token claro

- **Servidor:** apenas o `token_hash` (SHA-256) é persistido em `page_tokens`. O token claro é retornado pelo endpoint de criação/rotação **uma única vez** na response e nunca mais.
- **Control-plane (cliente):** após criação ou rotação, o control-plane grava o token claro em `localStorage` na chave `gt:token:<page_public_id>` para permitir exibição posterior do snippet. Isso é uma conveniência de UX restrita ao browser do usuário; **não** muda o contrato de servidor (o backend continua sem qualquer cópia em claro). Se o `localStorage` estiver vazio (browser diferente, modo anônimo), o snippet aparece mascarado e a única forma de obter token novo é via `rotatePageToken()`.

## 7. Invariantes

- **INV-PAGE-001 — `public_id` é único por launch.** `unique (launch_id, public_id)`. Testável.
- **INV-PAGE-002 — `allowed_domains` não está vazio em modo `b_snippet`.** Validador de domínio: integração externa precisa saber de onde aceitar request. Testável.
- **INV-PAGE-003 — `token_hash` é único globalmente.** `unique (page_tokens.token_hash)`. Testável.
- **INV-PAGE-004 — Cada page tem ao menos um page_token `active` enquanto `pages.status='active'`.** Validador no service. Testável.
- **INV-PAGE-005 — Token `revoked` não autentica.** Edge retorna 401 + métrica `legacy_token_in_use=false` para tokens revoked (separado de `rotating`). Testável.
- **INV-PAGE-006 — `event_config` é Zod-válido.** Schema `EventConfigSchema` valida no momento do save. Testável.
- **INV-PAGE-007 — Origem do request é validada contra `allowed_domains` em modo `b_snippet`.** Edge faz match por sufixo (subdomain ok). Testável.

## 8. BRs relacionadas

- `BR-RBAC-002` — Cross-workspace via page_token.
- `BR-PAGE-001` — Token rotation tem janela de overlap.

## 9. Contratos consumidos

- `MOD-LAUNCH.requireActiveLaunch()`
- `MOD-AUDIT.recordAuditEntry()` (em rotação/revogação)

## 10. Contratos expostos

- `getPageByToken(token_hash, ctx): Result<{page, launch, status}, InvalidToken | RevokedToken>`
- `validateOrigin(page, origin_header): Result<void, OriginNotAllowed>`
- `rotatePageToken(page_id, actor, ctx): Result<{new_token_clear, new_token_id}, InvalidPage>`
- `revokePageToken(token_id, actor, ctx): Result<void>`
- `getActiveTokens(page_id, include_rotating: boolean): Result<PageToken[]>`

## 11. Eventos de timeline emitidos

- `TE-PAGE-CREATED`
- `TE-PAGE-STATUS-CHANGED`
- `TE-PAGE-CONFIG-UPDATED`
- `TE-PAGE-TOKEN-CREATED`
- `TE-PAGE-TOKEN-ROTATED`
- `TE-PAGE-TOKEN-REVOKED`

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/page.ts`
- `packages/db/src/schema/page_token.ts`
- `apps/edge/src/lib/page.ts`
- `apps/edge/src/lib/page-token.ts`
- `apps/edge/src/middleware/auth-public-token.ts`
- `apps/edge/src/middleware/cors.ts`
- `tests/unit/page/**`
- `tests/integration/page/**`

**Lê:**
- `apps/edge/src/lib/launch.ts`
- `apps/edge/src/lib/audit.ts`
- `30-contracts/01-enums.md`

## 13. Dependências permitidas / proibidas

**Permitidas:** `MOD-LAUNCH`, `MOD-WORKSPACE`, `MOD-AUDIT`.
**Proibidas:** `MOD-EVENT`, `MOD-LEAD`, etc. (esses dependem de Page).

## 14. Test harness

- `tests/unit/page/event-config-schema.test.ts` — Zod validation.
- `tests/integration/page/token-rotation-overlap.test.ts` — token antigo aceito durante janela; rejeitado após.
- `tests/integration/page/origin-validation.test.ts` — INV-PAGE-007.
- `tests/integration/page/revoked-token-rejected.test.ts` — INV-PAGE-005.
