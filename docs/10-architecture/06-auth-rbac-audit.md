# 06 — Auth, RBAC e Audit

## Camadas de autenticação

| Caller | Tipo | Como autentica |
|---|---|---|
| Tracker.js (browser) | Public token | `X-Funil-Site: pk_live_...` (page_token) |
| Webhook inbound (Hotmart, Stripe) | Provider signature | HMAC ou shared secret por provedor |
| Control Plane UI (Fase 4) | Session cookie | Supabase Auth + JWT |
| API Key (server-to-server) | API key + scopes | `Authorization: Bearer <api_key>` + scope check |

## Public token (page_token)

- Emitido por `MOD-PAGE.rotatePageToken()` apenas a OPERATOR/ADMIN.
- Hash SHA-256 armazenado em `page_tokens.token_hash`. Token claro mostrado uma vez.
- Algoritmo de hash: `SHA-256(TextEncoder('utf-8').encode(tokenHexString))`, onde `tokenHexString` é a representação hex-string dos 32 bytes aleatórios do token. Geração e validação usam o mesmo input — o middleware recebe o token hex-string via header e recomputa o hash antes de comparar com `page_tokens.token_hash`.
- Status `active`/`rotating`/`revoked` com janela de overlap (ADR-023).
- Não dá acesso a operações administrativas — escopo é estrito a `/v1/config`, `/v1/events`, `/v1/lead`.

## Lead token (`__ftk`)

- Emitido por `/v1/lead` após sucesso.
- HMAC-SHA256 stateless com claim `{workspace_id, lead_id, page_token_hash, exp}`.
- Cookie `__ftk; SameSite=Lax; Secure; HttpOnly=false` (HttpOnly false — tracker precisa ler).
- TTL 60d default (configurável).
- Binding ao `page_token_hash` previne uso cross-page (BR-IDENTITY-005).
- Revogação ativa via `lead_tokens.revoked_at`.

## Control Plane (Fase 4)

- Supabase Auth para login de usuário humano.
- Email + password ou OAuth providers.
- 2FA obrigatório para roles owner/admin/privacy.
- Sessão JWT com claims `{workspace_id, user_id, role}` propagados em cada request.

## API Keys

Tabela `workspace_api_keys`:
- `key_hash` (SHA-256 do segredo).
- `scopes: text[]` — ex.: `['events:write', 'leads:erase']`.
- `created_at`, `last_used_at`, `revoked_at`.

Validação `validateApiKeyScope()` em `MOD-WORKSPACE`.

## RBAC

Detalhe completo em [`00-product/03-personas-rbac-matrix.md`](../00-product/03-personas-rbac-matrix.md) e [`50-business-rules/BR-RBAC.md`](../50-business-rules/BR-RBAC.md).

Roles: `owner`, `admin`, `marketer`, `operator`, `privacy`, `viewer`, `api_key`.

Implementação em camadas:

1. **Middleware HTTP**: `apps/edge/src/middleware/auth-*.ts` + `apps/edge/src/middleware/authz.ts`. Injeta `Ctx` com `actor_id`, `actor_type`, `role` (ou scopes).
2. **Service layer**: cada operação de domínio recebe `ctx` e verifica role/scope antes de executar.
3. **DB layer**: RLS bloqueia cross-workspace queries (defesa em profundidade).

## Defesa em profundidade

```
Request → Middleware HTTP (auth) → Service (authz check) → DB (RLS) → Resposta
```

Se qualquer camada falha, request é rejeitada. Bug em uma camada não vaza dados — outras camadas blockam.

## RLS (Row-Level Security)

Política padrão (ver [`03-data-layer.md`](03-data-layer.md)). Setting `app.current_workspace_id` setado no middleware antes de qualquer query.

```ts
// apps/edge/src/middleware/workspace-context.ts
app.use(async (c, next) => {
  const workspaceId = c.get('workspace_id');
  await c.get('db').execute(`set local app.current_workspace_id = '${workspaceId}'`);
  await next();
});
```

## 2FA (Fase 4)

OWNER, ADMIN, PRIVACY exigem 2FA. Métodos: TOTP (Google Authenticator), WebAuthn (biometria).

API keys não têm 2FA — escopo é a defesa.

## Audit log

Toda ação sensível registra entry em `audit_log` (BR-AUDIT-*). Spec completa em [`30-contracts/06-audit-trail-spec.md`](../30-contracts/06-audit-trail-spec.md).

Helper `recordAuditEntry()` central. Falha de audit não impede operação (audit é best-effort em path crítico) mas é alertada.

## Sanitização de logs

Logger em `apps/edge/src/middleware/sanitize-logs.ts`:
- Redact list pré-configurada: `email`, `phone`, `name`, `ip`, `password`, `token`, `secret`, `key`, `authorization`.
- Aplicado a todo log estruturado.
- Test integration valida zero PII em logs (BR-PRIVACY-001).

## Secret management

| Secret | Onde | Quem rotaciona |
|---|---|---|
| `PII_MASTER_KEY_V{n}` | Wrangler secret + Supabase Vault | OPERATOR (anual) |
| `LEAD_TOKEN_HMAC_SECRET` | Wrangler secret | OPERATOR (anual ou em incidente) |
| `META_CAPI_TOKEN` | Wrangler secret (Fase 1) → `integration_credentials` por workspace (Fase 4) | OPERATOR |
| `STRIPE_WEBHOOK_SECRET` | Mesmo | OPERATOR |
| `GOOGLE_ADS_REFRESH_TOKEN` | Mesmo | OPERATOR |
| Page tokens em claro | Não armazenados (apenas hash) | — |

Rotação trimestral mínima documentada em runbooks.

## Cross-workspace security (AUTHZ-005)

Mesmo OWNER não pode ler dados de outro workspace. RLS é defesa primária; service layer reforça com filtro explícito.

Exceção: super-admin do GlobalTracker (operador interno do produto) tem credencial separada para suspender workspace, debugar incidentes — fora do RBAC normal. Acessos super-admin são auditados em `audit_log` separado e visíveis para o owner do workspace.
