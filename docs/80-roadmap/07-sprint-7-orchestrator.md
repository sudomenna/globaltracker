# Sprint 7 — Orchestrator e automação (Fase 5)

## Duração
4 semanas.

## Objetivo
Introduzir Trigger.dev 3.x como motor de workflows longos com aprovação humana. Criar `apps/orchestrator/` e `apps/lp-templates/` (Astro 4.x + CF Pages). Ao final, operador deploya nova LP em < 5 min via UI, provisiona estrutura de campanha Meta/Google com aprovação humana e aciona rollback se necessário.

## Critérios de aceite do sprint

- [ ] Operador cria LP em < 5 min via UI: escolhe template Astro, preenche slug/domínio, workflow `deploy-lp` publica em CF Pages com tracker pré-instalado e page_token emitido.
- [ ] Workflow `setup-tracking` configura pixel policy + event_config + page_token para uma Page após criação.
- [ ] Workflow `provision-campaigns` gera estrutura Meta Ad Set + Google Ads Campaign e pausa para aprovação humana antes de ativar.
- [ ] Aprovação humana no CP desbloqueia o workflow e ativa as campanhas via API.
- [ ] Rollback via `POST /v1/orchestrator/workflows/:run_id/rollback` desfaz as mudanças criadas pelo provision-campaigns.
- [ ] Audit log registra cada etapa dos workflows (trigger, approval, rollback, failure).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` verdes ao fim de cada onda.

---

## T-IDs — decomposição completa

> **Agente → T-ID**: ver árvore de decisão em `CLAUDE.md §2`.
> `parallel-safe=yes` = pode rodar em paralelo com outras T-IDs da mesma onda (ownership disjunto).

### Tabela mestre

| T-ID | Tipo | Título curto | Onda | parallel-safe | Deps | Agente |
|---|---|---|---|---|---|---|
| T-7-000 | contract-change | Contratos de API do Orchestrator em `docs/30-contracts/05-api-server-actions.md` | 0 | **no** | — | docs-sync |
| T-7-001 | schema | Tabelas `workflow_runs`, `lp_deployments`, `campaign_provisions` | 1 | yes | T-7-000 | schema-author |
| T-7-002 | bootstrap | Bootstrap `apps/orchestrator/` — Trigger.dev 3.x + pnpm workspace | 1 | yes | — | general-purpose |
| T-7-003 | bootstrap | Bootstrap `apps/lp-templates/` — Astro 4.x + CF Pages config + template capture | 1 | yes | — | general-purpose |
| T-7-004 | edge | Rotas `/v1/orchestrator/*` — trigger, status, approve, rollback | 2 | yes | T-7-000, T-7-001 | edge-author |
| T-7-005 | orchestrator | Workflow `setup-tracking` (configura pixel + event_config + page_token) | 2 | yes | T-7-002 | general-purpose |
| T-7-006 | orchestrator | Workflow `deploy-lp` (fork template Astro → build → CF Pages deploy) | 2 | yes | T-7-002, T-7-003 | general-purpose |
| T-7-007 | orchestrator | Workflow `provision-campaigns` com `waitForEvent` (aprovação humana) | 3 | yes | T-7-004, T-7-005 | general-purpose |
| T-7-008 | orchestrator | Workflow `rollback-provisioning` (desfaz Meta/Google via API) | 3 | yes | T-7-004 | general-purpose |
| T-7-009 | cp | UI de workflows no Control Plane (trigger + approval queue + status) | 3 | yes | T-7-004 | general-purpose |
| T-7-010 | test | Testes unit + integration (orchestrator tasks + edge routes) | 4 | yes | T-7-001..T-7-009 | test-author |
| T-7-011 | audit | BR Auditor pré-merge | 5 | **no** | T-7-001..T-7-010 | br-auditor |

---

## Plano de ondas

> Máximo de 5 T-IDs por onda. Verificação `pnpm typecheck && pnpm lint && pnpm test` entre cada onda.

---

### Onda 0 — Contract-change (serial, sozinha)

> Mudanças em `docs/30-contracts/` são sempre seriais (CLAUDE.md §3).

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-7-000** | `docs/30-contracts/05-api-server-actions.md` | Adicionar seção `## Orchestrator API` com os 6 contratos abaixo. Nenhum arquivo de código tocado nesta onda. |

**Contratos a definir em T-7-000:**

| CONTRACT-ID | Método + Path | Auth | Descrição |
|---|---|---|---|
| `CONTRACT-orc-trigger-setup-tracking-v1` | `POST /v1/orchestrator/workflows/setup-tracking` | session OPERATOR/ADMIN | Dispara workflow; body: `{ page_id: uuid, launch_id: uuid }` |
| `CONTRACT-orc-trigger-deploy-lp-v1` | `POST /v1/orchestrator/workflows/deploy-lp` | session OPERATOR/ADMIN | Dispara deploy; body: `{ template: string, launch_id: uuid, slug: string, domain?: string }` |
| `CONTRACT-orc-trigger-provision-campaigns-v1` | `POST /v1/orchestrator/workflows/provision-campaigns` | session OPERATOR/ADMIN | Dispara provisioning; body: `{ launch_id: uuid, platforms: ('meta'\|'google')[] }` |
| `CONTRACT-orc-status-v1` | `GET /v1/orchestrator/workflows/:run_id` | session OPERATOR/ADMIN | Retorna `{ run_id, workflow, status, steps[], created_at, updated_at }` |
| `CONTRACT-orc-approve-v1` | `POST /v1/orchestrator/workflows/:run_id/approve` | session OPERATOR/ADMIN | Desbloqueia step de aprovação; body: `{ justification: string }` |
| `CONTRACT-orc-rollback-v1` | `POST /v1/orchestrator/workflows/:run_id/rollback` | session OPERATOR/ADMIN | Aciona rollback do workflow; body: `{ reason: string }` |

---

### Onda 1 — Bootstrap paralelo (3 em paralelo)

> Sem dependências cruzadas entre si. Roda logo após onda 0.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-7-001** | `packages/db/src/schema/orchestrator.ts`, `packages/db/migrations/0025_workflow_runs.sql` (+ `supabase/migrations/`) | Três tabelas: `workflow_runs (id uuid pk, workspace_id, workflow text, status, trigger_payload jsonb, result jsonb, created_at, updated_at)` + `lp_deployments (id, workspace_id, run_id fk, launch_id, template, slug, domain, cf_pages_url, status, deployed_at)` + `campaign_provisions (id, workspace_id, run_id fk, launch_id, platform, external_id text, status, provision_payload jsonb, rollback_payload jsonb, created_at)`. RLS: `workspace_id = current_workspace_id()`. Drizzle schema + Zod infer exports em `packages/db/src/schema/orchestrator.ts`. Migrations geradas e aplicadas no Supabase. |
| **T-7-002** | `apps/orchestrator/**` (criação) | Novo app `apps/orchestrator/` no workspace pnpm. `package.json` com `@trigger.dev/sdk ^3.x`, `@trigger.dev/build ^3.x`, TypeScript 5.x. `trigger.config.ts` na raiz com `project: 'globaltracker'`. Diretório `apps/orchestrator/src/tasks/` criado. `apps/orchestrator/src/client.ts` exporta `tasks` centralizados. `pnpm build` verde (mesmo que tasks ainda sem lógica). |
| **T-7-003** | `apps/lp-templates/**` (criação) | Novo app `apps/lp-templates/` no workspace pnpm. Astro 4.x com `output: 'static'`, CF Pages adapter (`@astrojs/cloudflare`). Template `src/templates/capture/` com: layout base, componente `<TrackerSnippet>` que injeta o script do `apps/tracker/` via public_id de page, formulário de captura de lead. `wrangler.toml` configurado para CF Pages. `pnpm build` gera `dist/` sem erros. |

**Verificação após onda 1:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 2 — Implementação base (3 em paralelo)

> Deps: T-7-000 (contratos) para T-7-004; T-7-002 para T-7-005 e T-7-006; T-7-003 para T-7-006.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-7-004** | `apps/edge/src/routes/orchestrator.ts` (novo) | Implementar os 6 contratos de T-7-000. Cada rota: (a) valida auth (session OPERATOR/ADMIN), (b) valida body via Zod, (c) insere/consulta `workflow_runs` via Hyperdrive, (d) emite `audit_log`. Trigger e status interagem com Trigger.dev SDK via `env.TRIGGER_SECRET_KEY`. Approve e rollback emitem evento externo (`triggerdev.sendEvent`). Erros: 404 `run_not_found`, 409 `not_approvable`, 409 `not_rollbackable`. |
| **T-7-005** | `apps/orchestrator/src/tasks/setup-tracking.ts` | Task Trigger.dev `setup-tracking`. Steps: (1) busca Page + Launch via edge API (`GET /v1/pages/:id`); (2) valida pixel_policy + event_config conforme INV-LAUNCH-003 e ADR-011; (3) emite page_token via `POST /v1/pages/:id/tokens`; (4) registra resultado em `workflow_runs.result`; (5) emite `audit_log` action=`workflow_step_completed`. Retry: 3 tentativas com backoff. Falha em qualquer step → status `failed` + audit. |
| **T-7-006** | `apps/orchestrator/src/tasks/deploy-lp.ts` | Task Trigger.dev `deploy-lp`. Steps: (1) recebe template + slug + launch_id; (2) fork do template Astro via CF Pages API (cria deployment com variáveis de ambiente `TRACKER_PAGE_PUBLIC_ID`, `TRACKER_WORKSPACE_PUBLIC_ID`); (3) aguarda deploy ready (polling CF Pages API); (4) insere `lp_deployments` com `cf_pages_url`; (5) chama `setup-tracking` como sub-task; (6) emite `TE-PAGE-CREATED` + audit. Retry: 3 tentativas. Timeout: 3 min. |

**Verificação após onda 2:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 3 — Workflows complexos + CP UI (3 em paralelo)

> Deps: T-7-004 para T-7-007, T-7-008, T-7-009; T-7-005 para T-7-007.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-7-007** | `apps/orchestrator/src/tasks/provision-campaigns.ts` | Task Trigger.dev `provision-campaigns`. Steps: (1) valida launch tem `live` status e pixel_policy; (2) cria Ad Set no Meta via `POST /v20/act_{account_id}/adsets` (paused); (3) cria Campaign no Google Ads via `mutate` (paused); (4) insere rows em `campaign_provisions` com `status='pending_approval'`; (5) **`wait.for({ event: 'approved', timeout: '72h' })`** — pausa workflow; (6) após approval: ativa Ad Set + Campaign via API; (7) atualiza `campaign_provisions.status='active'`; (8) audit em cada step. Rollback payload gravado em `campaign_provisions.rollback_payload` (IDs externos + estado anterior). |
| **T-7-008** | `apps/orchestrator/src/tasks/rollback-provisioning.ts` | Task Trigger.dev `rollback-provisioning`. Recebe `run_id`. Lê `campaign_provisions` do run. Para cada provision: (a) chama Meta API `DELETE` no Ad Set; (b) chama Google Ads API `remove` na Campaign. Atualiza `campaign_provisions.status='rolled_back'` e `workflow_runs.status='rolled_back'`. Emite audit `action='workflow_rollback'` com reason. Idempotente: status `already_rolled_back` se row já tiver `rolled_back`. |
| **T-7-009** | `apps/control-plane/app/(app)/orchestrator/**` | Três telas no CP: (1) `/orchestrator` — lista `workflow_runs` do workspace com status, tipo, created_at; (2) `/orchestrator/:run_id` — detalhe do run com steps, status badge, botões Approve / Rollback (disabled se status não permite); (3) `/orchestrator/new` — formulário para disparar `deploy-lp` ou `provision-campaigns`. Integra com `GET/POST /v1/orchestrator/*`. Sidebar entry "Workflows" em `apps/control-plane/src/components/sidebar.tsx`. Status badges: `pending` → amarelo, `waiting_approval` → azul pulsante, `completed` → verde, `failed`/`rolled_back` → vermelho. |

**Verificação após onda 3:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 4 — Testes (paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-7-010** | `tests/unit/orchestrator/**`, `tests/integration/orchestrator/**` | Testes unit para tasks (mock de CF Pages API, Meta API, Google Ads API). Testes integration para edge routes `/v1/orchestrator/*` (trigger → status → approve → rollback). Coverage: `workflow_runs` transitions, `campaign_provisions` state machine, rollback idempotência, audit entries gerados. Mínimo 30 novos testes verdes. `pnpm test` verde. |

---

### Onda 5 — Auditoria BR pré-merge (serial)

| T-ID | Critério de aceite |
|---|---|
| **T-7-011** | Auditor verifica: BR-AUDIT-001 citado em cada mutação sensível; BR-RBAC-002 (workspace_id scope) em todas queries; BR-DISPATCH-005 (replay manual) ainda coberto; INV-LAUNCH-003 verificado no setup-tracking. Relatório com BRs OK / missing. |

---

## Notas técnicas

### Trigger.dev 3.x (ADR-008)

- Tasks definidas em `apps/orchestrator/src/tasks/*.ts`.
- `trigger.config.ts` na raiz de `apps/orchestrator/`.
- Variável de ambiente `TRIGGER_SECRET_KEY` necessária no orchestrator app.
- Aprovação humana implementada via `wait.for({ event: 'approved', timeout: '72h' })` — edge route `/v1/orchestrator/workflows/:run_id/approve` emite o evento via `triggerdev.sendEvent`.
- Não concorre com CF Queues (CF Queues = tasks curtas idempotentes; Trigger.dev = state machine longa).

### CF Pages + Astro (ADR-001)

- Deploy via CF Pages API (`POST /client/v4/accounts/{account_id}/pages/projects/{project}/deployments`).
- Template capture pre-instala `apps/tracker/dist/tracker.js` via script tag com `data-page-id` e `data-workspace-id`.
- `PAGE_TOKEN_ROTATION_OVERLAP_DAYS` default 14 dias (ADR-023).

### Dois diretórios de migrations (MEMORY.md §5)

Ao criar `packages/db/migrations/0025_*.sql`, copiar para `supabase/migrations/20260502000025_*.sql`.

### Dispatch-replay (Sprint 6 debt)

`apps/edge/src/routes/dispatch-replay.ts` existe com implementação de T-6-008, mas response shape diverge do CONTRACT-api-dispatch-replay-v1 (retorna 200 com `{ queued, job_id, destination }` em vez de 202 com `{ new_job_id, status }`). Fix incluído em T-7-004 (edge-author alinha o contrato ao implementar as novas rotas de orchestrator no mesmo arquivo — ou abre T-ID separada se o orquestrador decidir).

### Secrets necessários (não deployados)

```
TRIGGER_SECRET_KEY         # Trigger.dev project secret
CF_ACCOUNT_ID              # para CF Pages API
CF_PAGES_API_TOKEN         # para CF Pages deploy
```

Além dos secrets já pendentes de sprints anteriores (ver MEMORY.md §5).

---

## Riscos

| Risco | Mitigação |
|---|---|
| Trigger.dev 3.x mudanças de API | Fixar `^3.0.0` + consultar changelog antes de onda 2 |
| CF Pages API rate limits | Polling com backoff exponencial em `deploy-lp` |
| Meta/Google API reject (provision) | Rollback automático em falha de step 2/3 + audit |
| Aprovação humana expira (72h) | Workflow move para `expired` + notificação CP + possibilidade de re-trigger |
| Sprint 6 dispatch-replay diverge do contrato | Fixar shape em T-7-004 ou T-ID isolada antes de onda 2 |
