# Sprint 6 — Control Plane UI (Fase 4 do rollout)

## Duração
3 semanas.

## Objetivo
Next.js 15 App Router com UI operacional para todas funcionalidades atualmente acessíveis via YAML/API.

## Critério de aceite do sprint

- [ ] Marketer cria lançamento end-to-end via UI sem YAML.
- [ ] CRUD de pages, links, audiences, integrations.
- [ ] Page token rotation via UI com janela de overlap visível.
- [ ] SAR/erasure UI com double-confirm.
- [ ] Audit log viewer com filtros.
- [ ] Multi-workspace operacional (até então MVP rodava 1 workspace).
- [ ] RBAC plenamente implementado (todos 7 roles + AUTHZ-001..012).
- [ ] 2FA obrigatório para owner/admin/privacy.

---

## T-IDs — decomposição completa

> **Agente → T-ID**: ver árvore de decisão em `CLAUDE.md §2`.
> `parallel-safe=yes` significa que a T-ID pode ser executada em paralelo com outras do mesmo número de onda.

### Tabela mestre

| T-ID | Tipo | Título curto | Onda | parallel-safe | Deps | Agente |
|---|---|---|---|---|---|---|
| T-6-001 | schema | `onboarding_state` em `workspaces` | 1 | yes | — | schema-author |
| T-6-002 | cp-bootstrap | Bootstrap Next.js 15 app (layout + auth + sidebar + header) | 1 | yes | — | general-purpose |
| T-6-003 | edge | `GET /v1/pages/:public_id/status` | 1 | yes | — | edge-author |
| T-6-004 | edge | `GET /v1/health/integrations` + `GET /v1/health/workspace` | 1 | yes | — | edge-author |
| T-6-007 | edge | `POST /v1/integrations/:provider/test` | 1 | yes | — | edge-author |
| T-6-005 | edge | `GET/PATCH /v1/onboarding/state` | 2 | yes | T-6-001 | edge-author |
| T-6-006 | cp | `<HealthBadge>` component + sidebar health polling | 2 | yes | T-6-002 | general-purpose |
| T-6-008 | edge | `POST /v1/dispatch-jobs/:id/replay` | 2 | yes | — | edge-author |
| T-6-009 | edge | `GET /v1/help/skip-reason/:reason` | 2 | yes | — | edge-author |
| T-6-010 | edge | `GET /v1/leads/:public_id/timeline` | 2 | yes | — | edge-author |
| T-6-011 | cp | Tela Onboarding Wizard `/onboarding` | 3 | yes | T-6-002,003,005,006 | general-purpose |
| T-6-012 | cp | Tela Page Registration `/launches/:id/pages` | 3 | yes | T-6-002,003,006 | general-purpose |
| T-6-013 | cp | Tela Integration Health `/integrations` | 3 | yes | T-6-002,004,007,008 | general-purpose |
| T-6-014 | cp | Tela Lead Timeline `/leads/:id?tab=timeline` | 3 | yes | T-6-002,006,010 | general-purpose |
| T-6-016 | cp | Workspace header health badge (B.4) | 3 | yes | T-6-002,004,006 | general-purpose |
| T-6-015 | cp | Page diagnostics A.4 (`origin_not_allowed`, `invalid_token`) | 4 | yes | T-6-012 | general-purpose |
| T-6-017 | cp | Deep-links helper `apps/control-plane/src/lib/deep-links.ts` | 4 | yes | T-6-002 | general-purpose |
| T-6-018 | cp | Timeline re-dispatch UI (C.3) + audit log confirm | 4 | yes | T-6-014,008 | general-purpose |
| T-6-019 | cp | Help tooltips transversais (F.1) + copy deck `skip-reason-copy.ts` | 4 | yes | T-6-002,009 | general-purpose |
| T-6-020 | test | Testes unit + integration (CP components + edge endpoints) | 5 | yes | T-6-003..019 | test-author |
| T-6-021 | test | A11y tests (axe-core) — HealthBadge, Onboarding, Page Registration | 5 | yes | T-6-006,011,012 | test-author |
| T-6-022 | cp-p2 | Glossary `/help/glossary` + "Por que isso aconteceu?" panel (F.2+F.3) | 5 | yes | T-6-002,009 | general-purpose |

---

## Plano de ondas (máximo 5 T-IDs por onda)

### Onda 1 — Fundação (5 em paralelo)

Nenhuma dependência cruzada. Roda imediatamente ao iniciar o sprint.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-6-001** | `packages/db/src/schema/workspace.ts`, `packages/db/migrations/` | Migration `ALTER TABLE workspaces ADD COLUMN onboarding_state JSONB NOT NULL DEFAULT '{}'` gerada, aplicada e schema Drizzle atualizado. Zod schema canônico em `packages/shared/src/schemas/onboarding-state.ts`. |
| **T-6-002** | `apps/control-plane/` (criação) | App Next.js 15 App Router rodando em `pnpm dev`. Supabase Auth configurado (login por email + redirect pós-login). Layout shell completo: sidebar com itens de navegação conforme `docs/70-ux/02-information-architecture.md`, header global com `<WorkspaceSwitcher>` placeholder e `<NotificationBell>` placeholder. shadcn/ui inicializado com tokens de cor de `docs/70-ux/01-design-system-tokens.md`. Rota `/onboarding` redirect automático se `onboarding_state.completed_at IS NULL`. |
| **T-6-003** | `apps/edge/src/routes/pages.ts` (novo sub-rota ou arquivo separado) | `GET /v1/pages/:public_id/status` retorna shape: `{ page_public_id, health_state, last_ping_at, events_today, events_last_24h, token_status, token_rotates_at, recent_issues[] }`. Estados calculados server-side conforme `docs/70-ux/07-component-health-badges.md §4`. |
| **T-6-004** | `apps/edge/src/routes/health.ts` (novo) | `GET /v1/health/integrations` retorna `{ state, providers: [...] }`. `GET /v1/health/workspace` retorna estado agregado (integrations + pages + audiences + privacy). Derivados de `dispatch_health_view`. Cache-Control: max-age=30. |
| **T-6-007** | `apps/edge/src/routes/integrations-test.ts` (novo) | `POST /v1/integrations/:provider/test` com body `{ source: 'config_screen' \| 'wizard' }`. Gera evento sintético sem PII, envia ao destino, persiste resultado em KV (`gt:test:{workspace_id}:{provider}:{timestamp}`). SSE ou resposta final com `{ status, latency_ms, phases }`. Suporta `meta`, `ga4`, `google_ads`. |

**Verificação após onda 1:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 2 — Endpoints restantes + HealthBadge (5 em paralelo)

Deps: T-6-001 (para T-6-005) e T-6-002 (para T-6-006).

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-6-005** | `apps/edge/src/routes/onboarding.ts` (novo) | `GET /v1/onboarding/state` retorna `onboarding_state` do workspace. `PATCH /v1/onboarding/state` valida body via Zod (schema de `packages/shared`), atualiza coluna, registra `audit_log` com `action='onboarding_step_updated'`. |
| **T-6-006** | `apps/control-plane/src/components/health-badge.tsx`, `sidebar-nav.tsx` | Componente `<HealthBadge>` com props `{ state, size, label?, incidentCount?, tooltip?, onClick? }` conforme `docs/70-ux/07-component-health-badges.md §2`. Três sizes: `xs` (dot-only), `sm` (dot+label), `md` (card). Sidebar atualizada com badges `xs` em "Integrações", "Lançamentos", "Audiences". Polling SWR 60s para `GET /v1/health/integrations`. |
| **T-6-008** | `apps/edge/src/routes/dispatch-jobs.ts` (novo sub-rota) | `POST /v1/dispatch-jobs/:id/replay` valida RBAC (OPERATOR/ADMIN apenas). Chama `requeueDeadLetter(job_id)` (BR-DISPATCH-005): reseta `attempt_count=0`, `status='pending'`. Registra `audit_log` com `action='reprocess_dlq'`, `actor`, `reason` (body obrigatório). Retorna `{ queued: true, job_id }`. |
| **T-6-009** | `apps/edge/src/routes/help.ts` (novo) | `GET /v1/help/skip-reason/:reason` retorna `{ title, body, action? }` em PT-BR para cada skip_reason do catálogo em `docs/70-ux/11-copy-deck-skip-messages.md §1-2`. Rota pública (não requer auth) para facilitar uso em embed. 404 para reason desconhecido. |
| **T-6-010** | `apps/edge/src/routes/leads.ts` (extensão) | `GET /v1/leads/:public_id/timeline?cursor=&filters=&limit=50` retorna `{ nodes[], next_cursor }`. Nodes pré-montados server-side a partir de joins: `events + dispatch_jobs + dispatch_attempts + lead_aliases + lead_attribution + lead_stages + lead_consents + lead_merges + audit_log`. Payload sanitizado por role (MARKETER vê PII mascarada, OPERATOR/ADMIN veem hashes). Cursor-based pagination. |

**Verificação após onda 2:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 3 — Telas principais (5 em paralelo)

Deps: todas as T-IDs de onda 1 e 2.

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-6-011** | `apps/control-plane/src/app/onboarding/` | Tela `/onboarding` completa conforme `docs/70-ux/03-screen-onboarding-wizard.md`. Stepper 5 passos. Passo 1: Meta Pixel + validação via `/integrations/meta/test`. Passo 2: GA4 (skippable). Passo 3: criar Launch via `POST /v1/launches`. Passo 4: criar Page via `POST /v1/launches/:id/pages`. Passo 5: snippet + polling de status. Re-entry funciona (mostra estado de cada passo). Skip total com modal de confirmação destrutiva. Banner "Setup incompleto" no header. |
| **T-6-012** | `apps/control-plane/src/app/launches/[launch_public_id]/pages/` | Tela `/launches/:id/pages/new` (criação) e `/launches/:id/pages/:page_public_id` (edição/detalhe) conforme `docs/70-ux/04-screen-page-registration.md`. Formulário de criação com domínios, modo, eventos. Pós-criação: snippet com token em claro + polling de status (`refreshInterval: 5000` → `60000` após primeiro ping). Modo edição: token mascarado, botão "Rotacionar token" com AlertDialog. |
| **T-6-013** | `apps/control-plane/src/app/integrations/` | Lista `/integrations` + detalhe `/integrations/[provider]` conforme `docs/70-ux/05-screen-integration-health.md`. Card de saúde 24h. Botão "Disparar evento de teste" com animação de fases sistema → CAPI → confirmação. Formulário de credenciais (edição OPERATOR/ADMIN apenas). Drill-down de dispatch_attempts em Sheet lateral. Deep-links externos. AUTHZ por elemento (tabela §9 do doc). |
| **T-6-014** | `apps/control-plane/src/app/leads/[lead_public_id]/` | Tela `/leads/:id` com aba `?tab=timeline` como default. Timeline vertical conforme `docs/70-ux/06-screen-lead-timeline.md`. Nodes com ícones lucide + badge de status colorido. Expandir payload via `<Collapsible>`. Filtros (tipo + status + período). Cursor pagination ("Carregar mais antigos"). Lead com SAR mostra banner. PII mascarada para MARKETER. Botão "Por que isso aconteceu?" em nodes 🔴/🟡 abre Sheet. |
| **T-6-016** | `apps/control-plane/src/components/app-header.tsx` | Header global atualizado com `<HealthBadge size="sm">` do workspace. Click abre painel lateral (Sheet lazy-loaded) com lista de incidentes ativos. Cada incidente tem link "Investigar" para a tela relevante. Polling SWR 60s para `GET /v1/health/workspace`. Banner "Setup incompleto" integrado ao header enquanto `onboarding_state.completed_at IS NULL`. |

**Verificação após onda 3:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 4 — P1 polish (4 em paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-6-015** | `apps/control-plane/src/app/launches/[launch_public_id]/pages/[page_public_id]/` (extensão de T-6-012) | Painel de diagnóstico contextualizado (A.4) na tela de page conforme `docs/70-ux/04-screen-page-registration.md §4`. Três cenários: `origin_not_allowed` (botão inline "Adicionar domínio"), `invalid_token` (botão "Ver snippet atual"), sem ping recente (checklist expandível). Fonte: `recent_issues` do endpoint de status. |
| **T-6-017** | `apps/control-plane/src/lib/deep-links.ts` | Módulo exportando funções tipadas: `metaEventsManager(pixelId)`, `metaTestEvents(pixelId)`, `metaDomainVerification()`, `metaAEM(pixelId)`, `ga4DebugView(propertyId)`, `ga4Realtime(propertyId)`, `ga4DataStreams(accountId, propertyId)`, `googleAdsConversions()`, `googleAdsConversionDetail(conversionId)`. Fallback para URL geral quando ID não disponível. Usada em T-6-013 (integrations) e T-6-011 (wizard). |
| **T-6-018** | `apps/control-plane/src/app/leads/[lead_public_id]/` (extensão de T-6-014) | Re-dispatch flow completo (C.3): AlertDialog com checkbox de confirmação + campo de justificativa obrigatória. Chama `POST /v1/dispatch-jobs/:id/replay`. Live region anuncia resultado ("Re-dispatch enfileirado"). MARKETER vê botão desabilitado com Tooltip "Apenas Operator/Admin". |
| **T-6-019** | `apps/control-plane/src/components/tooltip-help.tsx`, `apps/control-plane/src/lib/skip-reason-copy.ts` | Componente `<TooltipHelp>` reutilizável (ⓘ) conforme `docs/70-ux/08-pattern-contextual-help.md §1`. `skip-reason-copy.ts` com dicionário completo de `docs/70-ux/11-copy-deck-skip-messages.md §1-2`. Tooltip aplicado em: campos Pixel ID, Token CAPI, Test Event Code, page_token, gclid, fbp/fbc. |

**Verificação após onda 4:** `pnpm typecheck && pnpm lint && pnpm test`

---

### Onda 5 — Testes + P2 (3 em paralelo)

| T-ID | Ownership | Critério de aceite |
|---|---|---|
| **T-6-020** | `tests/unit/control-plane/`, `tests/integration/control-plane/` | Testes unit: `health-badge.test.tsx` (todos estados), `health-aggregation.test.ts` (thresholds), `deep-links.test.ts` (URLs corretas). Integration: `onboarding-wizard.test.tsx` (happy path + skip + resume), `page-registration.test.tsx`, `page-status-polling.test.tsx`, `integration-health.test.tsx`, `integration-test.test.tsx` (3 cenários de falha), `lead-timeline.test.tsx`, `lead-timeline-payload-authz.test.tsx`, `lead-timeline-redispatch.test.tsx`. Todos passando. |
| **T-6-021** | `tests/a11y/` | `axe-core` zero violations em: `onboarding.test.tsx`, `health-badge.test.tsx`, `page-registration.test.tsx`. WCAG AA verificado conforme `docs/70-ux/10-accessibility.md`: aria-live, aria-current, aria-label em todos os pontos críticos. |
| **T-6-022** | `apps/control-plane/src/app/help/glossary/`, `apps/control-plane/src/components/why-failed-sheet.tsx` | `/help/glossary` com termos canônicos de `docs/00-product/06-glossary.md` renderizados, buscáveis, linkáveis. `<WhyFailedSheet>` (F.3): painel lateral reutilizável consumindo `GET /v1/help/skip-reason/:reason` + conteúdo inline de diagnóstico. Ligado a nodes 🔴/🟡 da timeline e à tela de integration health. |

**Verificação final de sprint:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

---

## Grafo de dependências (resumo visual)

```
Onda 1 (paralela, sem deps):
  T-6-001 (schema)
  T-6-002 (CP bootstrap)    ←── crítico: bloqueia toda UI
  T-6-003 (edge: status)
  T-6-004 (edge: health)
  T-6-007 (edge: test)

Onda 2 (paralela):
  T-6-005 (edge: onboarding) ← T-6-001
  T-6-006 (CP: HealthBadge)  ← T-6-002
  T-6-008 (edge: replay)
  T-6-009 (edge: skip-reason)
  T-6-010 (edge: timeline)

Onda 3 (paralela — telas principais):
  T-6-011 (CP: Onboarding wizard)     ← T-6-002,003,005,006
  T-6-012 (CP: Page registration)     ← T-6-002,003,006
  T-6-013 (CP: Integration health)    ← T-6-002,004,007,008
  T-6-014 (CP: Lead timeline)         ← T-6-002,006,010
  T-6-016 (CP: Workspace header)      ← T-6-002,004,006

Onda 4 (paralela — P1 polish):
  T-6-015 (CP: Page diagnostics)      ← T-6-012
  T-6-017 (CP: Deep-links helper)     ← T-6-002
  T-6-018 (CP: Re-dispatch UI)        ← T-6-014,008
  T-6-019 (CP: Tooltips + copy deck)  ← T-6-002,009

Onda 5 (paralela — testes + P2):
  T-6-020 (tests: unit + integration)
  T-6-021 (tests: a11y)
  T-6-022 (CP P2: glossary + why-failed)
```

---

## Notas de implementação

### T-6-002 — Bootstrap control-plane (detalhe)

O `apps/control-plane/` não existe no repo. O bootstrap deve criar:

```
apps/control-plane/
├── src/
│   ├── app/
│   │   ├── layout.tsx           # RootLayout com sidebar + header
│   │   ├── (auth)/login/        # login page Supabase Auth
│   │   ├── onboarding/          # T-6-011
│   │   ├── launches/            # T-6-012
│   │   ├── integrations/        # T-6-013
│   │   ├── leads/               # T-6-014
│   │   └── help/                # T-6-022
│   ├── components/
│   │   ├── sidebar-nav.tsx
│   │   ├── app-header.tsx
│   │   └── health-badge.tsx     # T-6-006
│   └── lib/
│       ├── supabase.ts          # client + server
│       └── swr.ts               # SWR config global
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json                 # next 15, shadcn, swr, react-hook-form, zod
```

Supabase Auth: usar `@supabase/ssr` (Next.js 15 middleware para session cookie).
2FA: Supabase MFA nativo (TOTP) — obrigatório para roles owner/admin/privacy.
API calls do CP para o Edge Worker: via `fetch` server-side usando `EDGE_WORKER_URL` env var.

### Edge endpoints — autenticação do CP

Requests do Control Plane ao Edge carregam `Authorization: Bearer <supabase_jwt>`. O Edge middleware deve validar o JWT via `SUPABASE_JWT_SECRET` (binding já existente ou novo secret). Middleware `apps/edge/src/middleware/auth-cp.ts` injeta `actor_id`, `workspace_id`, `role` em `ctx`.

### OQ-012 aberta (não bloqueia Sprint 6)

OQ-012 (GA4 client_id para comprador direto no checkout sem `__fvid`) permanece aberta.
Não impacta nenhuma T-ID desta sprint.

---

## Referências de spec por tela

| T-ID | Spec primária | Specs secundárias |
|---|---|---|
| T-6-011 | [`docs/70-ux/03-screen-onboarding-wizard.md`](../70-ux/03-screen-onboarding-wizard.md) | 04, 05, 09, 11 |
| T-6-012 | [`docs/70-ux/04-screen-page-registration.md`](../70-ux/04-screen-page-registration.md) | 07, 09, 11 |
| T-6-013 | [`docs/70-ux/05-screen-integration-health.md`](../70-ux/05-screen-integration-health.md) | 07, 08, 09, 11 |
| T-6-014 | [`docs/70-ux/06-screen-lead-timeline.md`](../70-ux/06-screen-lead-timeline.md) | 08, 09, 11 |
| T-6-006,016 | [`docs/70-ux/07-component-health-badges.md`](../70-ux/07-component-health-badges.md) | 02, 09 |
| T-6-019 | [`docs/70-ux/08-pattern-contextual-help.md`](../70-ux/08-pattern-contextual-help.md) | 11 |
| T-6-022 | [`docs/70-ux/08-pattern-contextual-help.md §2-3`](../70-ux/08-pattern-contextual-help.md) | 06 (glossary) |
