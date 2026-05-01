# MEMORY.md

> **Estado de sessão volátil.** Não é fonte canônica.
> Decisões grandes migram para ADR em `docs/90-meta/04-decision-log.md`.
> Open Questions migram para `docs/90-meta/03-open-questions-log.md`.
> Este arquivo pode ser limpo entre sessões — preserve apenas o que afeta a próxima sessão.

## §0 Feedback operacional

Anote aqui feedback recente do humano que afeta como você (agente) deve trabalhar nesta conversa atual.

(vazio)

## §1 Bloqueios e pendências de stack [STACK-BLOQUEIO]

Anote aqui itens de stack que não estão funcionando conforme esperado. Use formato:

```
[STACK-BLOQUEIO] <item>
- Esperado: ...
- Observado: ...
- Hipótese: ...
- Tentativas: ...
- Próximo passo: pedir ao humano
```

(vazio)

## §2 Divergências doc ↔ código [SYNC-PENDING]

Anote aqui quando código foi alterado mas doc canônica ainda não. Prazo: até final do sprint.

```
[SYNC-PENDING] <doc afetada>
- Mudança em código: <commit/branch>
- Doc a atualizar: <path>
- Razão de não atualizar agora: <razão>
- ETA: <sprint X dia Y>
```

(vazio)

## §3 Modelo de negócio (decisões do usuário ainda não em ADR)

Decisões de produto/operação tomadas em conversas com o humano que ainda não viraram ADR formal mas afetam implementação.

Formato sugerido:
```
YYYY-MM-DD — <decisão curta>. <motivação>. Mover para ADR se persistir.
```

(vazio)

## §4 Estado dos sprints — fontes canônicas

| Sprint | Status | Fonte canônica |
|---|---|---|
| Sprint 0 | not_started (aguardando P0 — ver §5) | `docs/80-roadmap/00-sprint-0-foundations.md` |
| Sprint 1 | planned | `docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md` |
| Sprint 2 | planned | `docs/80-roadmap/02-sprint-2-runtime-tracking.md` |
| Sprint 3 | planned | `docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md` |
| Sprint 4 | planned | `docs/80-roadmap/04-sprint-4-analytics-google.md` |
| Sprint 5 | planned | `docs/80-roadmap/05-sprint-5-audience-multitouch.md` |
| Sprint 6 | planned | `docs/80-roadmap/06-sprint-6-control-plane.md` |
| Sprint 7 | planned | `docs/80-roadmap/07-sprint-7-orchestrator.md` |
| Sprint 8 | planned | `docs/80-roadmap/08-sprint-8-ai-dashboard.md` |

Status legends: `not_started`, `in_progress`, `completed`, `paused`, `blocked`.

## §5 Ponto atual de desenvolvimento

```
Estado:        PRE-SPRINT 0
Documentação:  COMPLETA (specs em docs/, organizadas em pirâmide 00-90)
Código:        NÃO INICIADO (apps/, packages/, tests/ ainda não existem)
Próximo passo: Sprint 0 — Foundations (após resolver P0 abaixo)
```

### Pendências PRÉ-Sprint 0 (resolver antes de iniciar implementação)

#### P0 — Bloqueantes para Sprint 0

| Pendência | Owner | Detalhe |
|---|---|---|
| Provisionar Cloudflare account + Worker + Queues + KV namespaces + Hyperdrive | OPERATOR | Necessário para T-0-004 (apps/edge wrangler dev). |
| Provisionar Supabase project (ou Supabase CLI local) | OPERATOR | Necessário para T-0-005 (migration zero). Recomendação: começar com CLI local. |
| Gerar `LEAD_TOKEN_HMAC_SECRET` (32+ bytes random) | OPERATOR | `openssl rand -base64 48`. Wrangler secret. |
| Gerar `PII_MASTER_KEY_V1` (32+ bytes random) | OPERATOR | `openssl rand -base64 48`. Wrangler secret. |
| Decidir OQ-007 (lead_token stateful vs stateless) | OWNER + tech lead | Recomendação: **stateful** — permite revogação SAR granular. Confirmar antes de Sprint 1 T-1-004. Ver [OQ-007](docs/90-meta/03-open-questions-log.md). |

#### P1 — Bloqueante para Sprint 2

| Pendência | Detalhe |
|---|---|
| Decidir OQ-004 (Turnstile vs honeypot puro vs Captcha) | Bloqueia Sprint 2 (`/v1/lead` precisa bot mitigation antes de produção). Recomendação: começar com honeypot+timing; adicionar Turnstile se spam aparecer. Ver [OQ-004](docs/90-meta/03-open-questions-log.md). |

#### P2 — Não-bloqueantes (decidir em Sprints 3-5)

| Pendência | Sprint afetado |
|---|---|
| OQ-001 — FX provider exato | Sprint 4 |
| OQ-002 — Política de retenção por categoria | Sprint 6 |
| OQ-003 — Estratégia de `client_id` GA4 quando `_ga` ausente | Sprint 4 |
| OQ-005 — Tiers de rate limit por workspace | Sprint 4 |
| OQ-006 — Heurísticas para flag manual de merge automático | Sprint 2-4 |

Detalhes em [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md).

### Como retomar em novo contexto (humano ou agente)

1. Ler esta seção §5 + `git status` + `git log -10`.
2. Carregar contexto base: [`docs/README.md`](docs/README.md) → [`AGENTS.md`](AGENTS.md) → [`CLAUDE.md`](CLAUDE.md).
3. Verificar P0 acima — marcar quando resolvido.
4. Iniciar Sprint 0 conforme [`docs/80-roadmap/00-sprint-0-foundations.md`](docs/80-roadmap/00-sprint-0-foundations.md) (Onda 1 começa com T-0-001).
5. Antes de Sprint 1: confirmar OQ-007.
6. Antes de Sprint 2: confirmar OQ-004.

### Decisões já tomadas (não reabrir)

ADR-001 a ADR-023 em [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md). Resumo:
- Stack: CF Workers + Hono + Postgres/Supabase + Drizzle + CF Queues; Trigger.dev só Fase 5
- Modelo "fast accept" (raw_events + processor async)
- Lead identity via `lead_aliases` + `lead_merges`
- Reidentificação via cookie `__ftk` HMAC (Fase 2)
- `visitor_id` adiado para Fase 3
- PII em 3 categorias com `pii_key_version` + HKDF
- Idempotency key canonicalizada por destination subresource
- Customer Match Google strategy condicional

## §6 Ambiente operacional

| Item | Valor |
|---|---|
| Branch atual | `main` |
| Supabase project | (a definir — ver §5 P0) |
| Cloudflare account | (a definir — ver §5 P0) |
| Secrets em Wrangler | (a gerar — ver §5 P0) |
| Node | 20 LTS |
| Package manager | pnpm 9.x |

### Checklist de provisionamento (resolver §5 P0)

```bash
# 1. Cloudflare
npm install -g wrangler
wrangler login

# 2. Secrets (gerar localmente, push via wrangler quando T-0-004 criar wrangler.toml)
openssl rand -base64 48  # → LEAD_TOKEN_HMAC_SECRET
openssl rand -base64 48  # → PII_MASTER_KEY_V1

# 3. Supabase
brew install supabase/tap/supabase
supabase init
# (start local quando precisar — durante T-0-005)

# 4. pnpm + Node
brew install pnpm
node --version  # confirmar >= 20
```

## Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para `docs/90-meta/04-decision-log.md` (ADR) ou `docs/90-meta/03-open-questions-log.md` (OQ).
- Não duplique aqui o que já está em ADR/OQ — referencie.
- Mantenha curto — se §5 ficar com mais de 30 linhas, separe sub-arquivo.
