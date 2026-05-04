# MOD-WORKSPACE — Workspace e configuração de tenant

## 1. Identidade

- **ID:** MOD-WORKSPACE
- **Tipo:** Core (fundação de multi-tenancy; todos os outros módulos dependem)
- **Dono conceitual:** OWNER + ADMIN

## 2. Escopo

### Dentro
- Criação, atualização, status (active/suspended/archived) de workspace.
- Configuração de moeda de normalização (`fx_normalization_currency`).
- Membership: vínculo de usuários a workspace com role.
- Crypto key derivada via HKDF a partir de `PII_MASTER_KEY_V{n}` + `salt=workspace_id` (ADR-009).

### Fora
- Billing (Fase 4+).
- Integrações de mídia (responsabilidade de `MOD-DISPATCH` / `40-integrations/`).
- Definição de role (responsabilidade do RBAC system; lista canônica em `00-product/03-personas-rbac-matrix.md`).

## 3. Entidades

### Workspace
Campos conceituais:
- `id` (UUID interno)
- `slug` (público, único global)
- `name`
- `status` (`active` / `suspended` / `archived`)
- `fx_normalization_currency` (default `BRL`)
- `created_at`, `updated_at`

### WorkspaceMember
- `id`
- `workspace_id`
- `user_id`
- `role` (`owner` / `admin` / `marketer` / `operator` / `privacy` / `viewer`)
- `invited_at`, `joined_at`, `removed_at`

### WorkspaceApiKey
- `id`
- `workspace_id`
- `name`
- `key_hash` (SHA-256 do segredo)
- `scopes` (`text[]`: `events:write`, `leads:erase`, etc.)
- `created_at`, `last_used_at`, `revoked_at`

### WorkspaceConfig (JSONB — coluna `workspaces.config`)

Configuração livre por workspace. Subcampos conhecidos documentados abaixo; outros campos são preservados pelo merge seguro.

#### `config.integrations.guru.product_launch_map` (Sprint 11)

Mapeamento de `product_id` do Digital Manager Guru para o launch e papel no funil correspondentes. Usado pelo `guru-launch-resolver.ts` como estratégia primária de resolução de `launch_id + funnel_role`.

**Shape:**

```jsonc
{
  "integrations": {
    "guru": {
      "product_launch_map": {
        // Chave: product.id recebido no webhook Guru (string arbitrária)
        // Valor: { launch_public_id, funnel_role }
        "prod_workshop_xyz": {
          "launch_public_id": "lcm-maio-2026",  // public_id do launch no workspace
          "funnel_role": "workshop"              // papel no funil; alimenta source_event_filters
        },
        "prod_main_xyz": {
          "launch_public_id": "lcm-maio-2026",
          "funnel_role": "main_offer"
        }
      }
    }
  }
}
```

**Como é atualizado:** via `PATCH /v1/workspace/config` (auth: OPERATOR/ADMIN). O endpoint realiza deep-merge seguro (SELECT→JS spread→UPDATE) — campos não enviados no body não são sobrescritos.

**Quem lê:** `apps/edge/src/lib/guru-launch-resolver.ts` — função `resolveLaunchForGuruEvent()`, estratégia `mapping`. Lê `workspaces.config` diretamente via Drizzle com escopo por `workspaceId`.

**Invariante:** não há constraint de DB sobre a estrutura interna do JSONB; a validação é feita na camada Edge via Zod (`PatchWorkspaceConfigBodySchema`) antes de qualquer escrita.

## 4. Relações

- `Workspace 1—N WorkspaceMember`
- `Workspace 1—N WorkspaceApiKey`
- `Workspace 1—N Launch` (`launches.workspace_id`)
- `Workspace 1—N {todas tabelas com workspace_id}` (multi-tenant fundamental)

## 5. Estados

```
[draft] → [active] → [suspended] → [active]
                  ↓
                [archived]  (terminal, soft-deleted)
```

`draft` existe brevemente durante criação (antes de owner confirmado); `suspended` é estado operacional (workspace pausado por inadimplência ou abuso); `archived` é terminal — dados permanecem para histórico, mas tracking é bloqueado.

## 6. Transições válidas

| De | Para | Quem pode |
|---|---|---|
| `draft` | `active` | Sistema (após owner confirmar) |
| `active` | `suspended` | OWNER, ADMIN do GlobalTracker (não do workspace) |
| `suspended` | `active` | OWNER, ADMIN do GlobalTracker |
| `active` | `archived` | OWNER (com double-confirm) |
| `suspended` | `archived` | OWNER, ADMIN do GlobalTracker |

Transição inválida (ex.: `archived` → `active`) lança erro de domínio. Recuperação requer ação administrativa explícita do GlobalTracker.

## 7. Invariantes

- **INV-WORKSPACE-001 — `slug` é único globalmente.** Constraint `unique` em `workspaces.slug`. Testável: tentar criar dois workspaces com mesmo slug deve falhar.
- **INV-WORKSPACE-002 — Workspace `archived` não aceita ingestão.** Edge Gateway rejeita `/v1/events`, `/v1/lead`, webhooks com 410 Gone se `workspaces.status='archived'`. Testável: integration test.
- **INV-WORKSPACE-003 — Cada workspace tem exatamente um owner ativo.** Soma de `WorkspaceMember where role='owner' and removed_at IS NULL` é sempre 1. Testável: trigger DB ou check em transition.
- **INV-WORKSPACE-004 — `fx_normalization_currency` é código ISO 4217 válido.** Constraint check em DB: `currency IN ('BRL', 'USD', 'EUR', 'GBP', ...)`. Testável: insert com `'XYZ'` falha.
- **INV-WORKSPACE-005 — API key revogada não autentica.** `WorkspaceApiKey where revoked_at IS NOT NULL` retorna 401. Testável: integration test.

## 8. BRs relacionadas

- `BR-RBAC-001` — Owner único por workspace (ver `50-business-rules/BR-RBAC.md`).
- `BR-RBAC-002` — Cross-workspace queries proibidas (AUTHZ-005).
- `BR-PRIVACY-001` — Crypto key derivada por workspace via HKDF.

## 9. Contratos consumidos

- `CONTRACT-api-admin-workspace-v1` (Control Plane → workspace CRUD; Fase 4).

## 10. Contratos expostos

- `getWorkspaceById(id, ctx): Result<Workspace, NotFound>`
- `requireActiveWorkspace(workspace_id, ctx): Result<Workspace, WorkspaceSuspended | WorkspaceArchived>`
- `getMemberRole(workspace_id, user_id): Result<Role, NotMember>`
- `validateApiKeyScope(key_hash, required_scope, ctx): Result<ApiKeyContext, Forbidden>`
- `deriveWorkspaceCryptoKey(workspace_id, version): CryptoKey`

Detalhes completos em `30-contracts/07-module-interfaces.md`.

## 11. Eventos de timeline emitidos

- `TE-WORKSPACE-CREATED`
- `TE-WORKSPACE-STATUS-CHANGED` (active/suspended/archived transitions)
- `TE-WORKSPACE-MEMBER-ADDED`
- `TE-WORKSPACE-MEMBER-REMOVED`
- `TE-WORKSPACE-API-KEY-CREATED`
- `TE-WORKSPACE-API-KEY-REVOKED`

Definidos em `30-contracts/03-timeline-event-catalog.md`.

## 12. Ownership de código

**Pode editar:**
- `packages/db/src/schema/workspace.ts`
- `packages/db/src/schema/workspace_member.ts`
- `packages/db/src/schema/workspace_api_key.ts`
- `apps/edge/src/lib/workspace.ts`
- `apps/edge/src/lib/api-key.ts`
- `apps/edge/src/middleware/auth-api-key.ts`
- `tests/unit/workspace/**`
- `tests/integration/workspace/**`

**Lê (não edita):**
- `apps/edge/src/lib/pii.ts` (precisa de `deriveWorkspaceCryptoKey`)
- `30-contracts/01-enums.md`

## 13. Dependências permitidas / proibidas

**Permitidas:** nenhuma — MOD-WORKSPACE é fundação.

**Proibidas:**
- Dependência de `MOD-LAUNCH`, `MOD-LEAD`, ou qualquer outro módulo de domínio (criaria circularidade — outros dependem de Workspace).

## 14. Test harness

- `tests/unit/workspace/derive-crypto-key.test.ts` — HKDF determinístico, chaves diferentes por workspace_id.
- `tests/unit/workspace/api-key-scope.test.ts` — scope check de API key.
- `tests/integration/workspace/lifecycle.test.ts` — transições de status.
- `tests/integration/workspace/rls.test.ts` — query sem `workspace_id` falha por RLS.
- `tests/integration/workspace/owner-uniqueness.test.ts` — INV-WORKSPACE-003.
