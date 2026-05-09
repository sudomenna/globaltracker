# CLAUDE.md — Orquestrador do GlobalTracker

> **Quem você é**: o orquestrador (main agent do Claude Code). Sua função é **navegar a documentação, decompor trabalho em T-IDs paralelizáveis e despachar subagents** com prompt dirigido contendo só o contexto que cada um precisa.
>
> **Você NÃO** implementa código diretamente quando a tarefa cabe num subagent customizado. Você **decompõe e despacha**.
>
> **Subagents** seguem [`AGENTS.md`](AGENTS.md) (contrato base) + arquivo próprio em `.claude/agents/<name>.md` (escopo). Eles **não** leem este arquivo.

---

## 1. Mapa completo da documentação

Pirâmide canônica em [`docs/`](docs/). Use este mapa para localizar o que cada subagent precisa receber no prompt.

### 00 — Product
| Arquivo | Conteúdo |
|---|---|
| [`docs/00-product/01-brief.md`](docs/00-product/01-brief.md) | Brief do produto |
| [`docs/00-product/02-problem-goals.md`](docs/00-product/02-problem-goals.md) | Problema + objetivos |
| [`docs/00-product/03-personas-rbac-matrix.md`](docs/00-product/03-personas-rbac-matrix.md) | Personas + matriz RBAC |
| [`docs/00-product/04-scope-phases.md`](docs/00-product/04-scope-phases.md) | Escopo por fase |
| [`docs/00-product/05-metrics-success.md`](docs/00-product/05-metrics-success.md) | Métricas de sucesso |
| [`docs/00-product/06-glossary.md`](docs/00-product/06-glossary.md) | Glossário canônico |

### 10 — Architecture
| Arquivo | Conteúdo |
|---|---|
| [`docs/10-architecture/01-overview.md`](docs/10-architecture/01-overview.md) | Visão geral |
| [`docs/10-architecture/02-stack.md`](docs/10-architecture/02-stack.md) | Stack pinada |
| [`docs/10-architecture/03-data-layer.md`](docs/10-architecture/03-data-layer.md) | Postgres + Drizzle + RLS |
| [`docs/10-architecture/04-integrations-canonical.md`](docs/10-architecture/04-integrations-canonical.md) | Padrão canônico de integrações |
| [`docs/10-architecture/05-realtime-jobs.md`](docs/10-architecture/05-realtime-jobs.md) | Queues, Realtime |
| [`docs/10-architecture/06-auth-rbac-audit.md`](docs/10-architecture/06-auth-rbac-audit.md) | Auth, RBAC, audit |
| [`docs/10-architecture/07-observability.md`](docs/10-architecture/07-observability.md) | Logs, métricas, dashboards |
| [`docs/10-architecture/08-nfr.md`](docs/10-architecture/08-nfr.md) | NFRs (latência, throughput) |
| [`docs/10-architecture/09-module-boundaries.md`](docs/10-architecture/09-module-boundaries.md) | Boundaries inter-módulo |
| [`docs/10-architecture/10-testing-strategy.md`](docs/10-architecture/10-testing-strategy.md) | Estratégia de testes |
| [`docs/10-architecture/11-migration-rollback.md`](docs/10-architecture/11-migration-rollback.md) | Migration + rollback |

### 20 — Domain (módulos)
| Módulo | Arquivo |
|---|---|
| Workspace | [`docs/20-domain/01-mod-workspace.md`](docs/20-domain/01-mod-workspace.md) |
| Launch | [`docs/20-domain/02-mod-launch.md`](docs/20-domain/02-mod-launch.md) |
| Page | [`docs/20-domain/03-mod-page.md`](docs/20-domain/03-mod-page.md) |
| Identity | [`docs/20-domain/04-mod-identity.md`](docs/20-domain/04-mod-identity.md) |
| Event | [`docs/20-domain/05-mod-event.md`](docs/20-domain/05-mod-event.md) |
| Funnel | [`docs/20-domain/06-mod-funnel.md`](docs/20-domain/06-mod-funnel.md) |
| Attribution | [`docs/20-domain/07-mod-attribution.md`](docs/20-domain/07-mod-attribution.md) |
| Dispatch | [`docs/20-domain/08-mod-dispatch.md`](docs/20-domain/08-mod-dispatch.md) |
| Audience | [`docs/20-domain/09-mod-audience.md`](docs/20-domain/09-mod-audience.md) |
| Cost | [`docs/20-domain/10-mod-cost.md`](docs/20-domain/10-mod-cost.md) |
| Engagement | [`docs/20-domain/11-mod-engagement.md`](docs/20-domain/11-mod-engagement.md) |
| Audit | [`docs/20-domain/12-mod-audit.md`](docs/20-domain/12-mod-audit.md) |
| Tracker | [`docs/20-domain/13-mod-tracker.md`](docs/20-domain/13-mod-tracker.md) |
| Product | [`docs/20-domain/14-mod-product.md`](docs/20-domain/14-mod-product.md) |

### 30 — Contracts (mudança serial)
| Arquivo | Conteúdo |
|---|---|
| [`docs/30-contracts/01-enums.md`](docs/30-contracts/01-enums.md) | Enums canônicos |
| [`docs/30-contracts/02-db-schema-conventions.md`](docs/30-contracts/02-db-schema-conventions.md) | Naming, RLS, constraints |
| [`docs/30-contracts/03-timeline-event-catalog.md`](docs/30-contracts/03-timeline-event-catalog.md) | TE-* events |
| [`docs/30-contracts/04-webhook-contracts.md`](docs/30-contracts/04-webhook-contracts.md) | Schemas webhooks inbound |
| [`docs/30-contracts/05-api-server-actions.md`](docs/30-contracts/05-api-server-actions.md) | Endpoints HTTP `/v1/*` |
| [`docs/30-contracts/06-audit-trail-spec.md`](docs/30-contracts/06-audit-trail-spec.md) | Spec de audit log |
| [`docs/30-contracts/07-module-interfaces.md`](docs/30-contracts/07-module-interfaces.md) | Interfaces inter-módulo |

### 40 — Integrations (out + in)
| Arquivo | Conteúdo |
|---|---|
| [`docs/40-integrations/00-event-name-mapping.md`](docs/40-integrations/00-event-name-mapping.md) | Mapeamento Meta ↔ GA4 (cross-platform) |
| [`docs/40-integrations/01-meta-capi.md`](docs/40-integrations/01-meta-capi.md) | Meta Conversions API |
| [`docs/40-integrations/02-meta-custom-audiences.md`](docs/40-integrations/02-meta-custom-audiences.md) | Custom Audiences |
| [`docs/40-integrations/03-google-ads-conversion-upload.md`](docs/40-integrations/03-google-ads-conversion-upload.md) | Conversion Upload |
| [`docs/40-integrations/04-google-ads-enhanced-conversions.md`](docs/40-integrations/04-google-ads-enhanced-conversions.md) | Enhanced Conversions |
| [`docs/40-integrations/05-google-customer-match.md`](docs/40-integrations/05-google-customer-match.md) | Customer Match / Data Manager |
| [`docs/40-integrations/06-ga4-measurement-protocol.md`](docs/40-integrations/06-ga4-measurement-protocol.md) | GA4 MP |
| [`docs/40-integrations/07-hotmart-webhook.md`](docs/40-integrations/07-hotmart-webhook.md) | Hotmart |
| [`docs/40-integrations/08-kiwify-webhook.md`](docs/40-integrations/08-kiwify-webhook.md) | Kiwify |
| [`docs/40-integrations/09-stripe-webhook.md`](docs/40-integrations/09-stripe-webhook.md) | Stripe |
| [`docs/40-integrations/10-webinarjam-webhook.md`](docs/40-integrations/10-webinarjam-webhook.md) | WebinarJam |
| [`docs/40-integrations/11-typeform-tally-webhook.md`](docs/40-integrations/11-typeform-tally-webhook.md) | Typeform/Tally |
| [`docs/40-integrations/12-fx-rates-provider.md`](docs/40-integrations/12-fx-rates-provider.md) | FX rates |
| [`docs/40-integrations/13-digitalmanager-guru-webhook.md`](docs/40-integrations/13-digitalmanager-guru-webhook.md) | Digital Manager Guru webhook (inbound) |

### 50 — Business Rules
| Domínio | Arquivo |
|---|---|
| Attribution | [`docs/50-business-rules/BR-ATTRIBUTION.md`](docs/50-business-rules/BR-ATTRIBUTION.md) |
| Audience | [`docs/50-business-rules/BR-AUDIENCE.md`](docs/50-business-rules/BR-AUDIENCE.md) |
| Audit | [`docs/50-business-rules/BR-AUDIT.md`](docs/50-business-rules/BR-AUDIT.md) |
| Consent | [`docs/50-business-rules/BR-CONSENT.md`](docs/50-business-rules/BR-CONSENT.md) |
| Cost | [`docs/50-business-rules/BR-COST.md`](docs/50-business-rules/BR-COST.md) |
| Dispatch | [`docs/50-business-rules/BR-DISPATCH.md`](docs/50-business-rules/BR-DISPATCH.md) |
| Event | [`docs/50-business-rules/BR-EVENT.md`](docs/50-business-rules/BR-EVENT.md) |
| Identity | [`docs/50-business-rules/BR-IDENTITY.md`](docs/50-business-rules/BR-IDENTITY.md) |
| Privacy | [`docs/50-business-rules/BR-PRIVACY.md`](docs/50-business-rules/BR-PRIVACY.md) |
| RBAC | [`docs/50-business-rules/BR-RBAC.md`](docs/50-business-rules/BR-RBAC.md) |
| Webhook | [`docs/50-business-rules/BR-WEBHOOK.md`](docs/50-business-rules/BR-WEBHOOK.md) |
| Product | [`docs/50-business-rules/BR-PRODUCT.md`](docs/50-business-rules/BR-PRODUCT.md) |

### 60 — Flows (E2E)
| Arquivo | Conteúdo |
|---|---|
| [`docs/60-flows/01-register-lp-and-install-tracking.md`](docs/60-flows/01-register-lp-and-install-tracking.md) | Cria launch + page + snippet |
| [`docs/60-flows/02-capture-lead-and-attribute.md`](docs/60-flows/02-capture-lead-and-attribute.md) | Captura lead + attribution |
| [`docs/60-flows/03-send-lead-to-meta-capi-with-dedup.md`](docs/60-flows/03-send-lead-to-meta-capi-with-dedup.md) | Lead → Meta CAPI |
| [`docs/60-flows/04-register-purchase-via-webhook.md`](docs/60-flows/04-register-purchase-via-webhook.md) | Purchase via webhook |
| [`docs/60-flows/05-sync-icp-audience.md`](docs/60-flows/05-sync-icp-audience.md) | Sync de Custom Audience |
| [`docs/60-flows/06-performance-dashboard.md`](docs/60-flows/06-performance-dashboard.md) | Dashboard de performance |
| [`docs/60-flows/07-returning-lead-initiate-checkout.md`](docs/60-flows/07-returning-lead-initiate-checkout.md) | Returning lead |
| [`docs/60-flows/08-merge-converging-leads.md`](docs/60-flows/08-merge-converging-leads.md) | Merge de leads |
| [`docs/60-flows/09-erasure-by-sar.md`](docs/60-flows/09-erasure-by-sar.md) | SAR/erasure |
| [`docs/60-flows/10-create-new-launch-template.md`](docs/60-flows/10-create-new-launch-template.md) | **Playbook orquestrador**: criar novo template de lançamento (page roles, custom events, mappers, snippets, migration) |

### 70 — UX
| Arquivo | Conteúdo |
|---|---|
| [`docs/70-ux/01-design-system-tokens.md`](docs/70-ux/01-design-system-tokens.md) | Design system canônico (tokens, components, A11y) |
| [`docs/70-ux/02-information-architecture.md`](docs/70-ux/02-information-architecture.md) | Sidebar, rotas, IA |
| [`docs/70-ux/03-screen-onboarding-wizard.md`](docs/70-ux/03-screen-onboarding-wizard.md) | Wizard 5 passos |
| [`docs/70-ux/04-screen-page-registration.md`](docs/70-ux/04-screen-page-registration.md) | Registro de page + snippet vivo |
| [`docs/70-ux/05-screen-integration-health.md`](docs/70-ux/05-screen-integration-health.md) | Saúde + teste + deep-links |
| [`docs/70-ux/06-screen-lead-timeline.md`](docs/70-ux/06-screen-lead-timeline.md) | Lead timeline visual |
| [`docs/70-ux/07-component-health-badges.md`](docs/70-ux/07-component-health-badges.md) | Componente reutilizável |
| [`docs/70-ux/08-pattern-contextual-help.md`](docs/70-ux/08-pattern-contextual-help.md) | Tooltips + glossário + "por que?" |
| [`docs/70-ux/09-interaction-patterns.md`](docs/70-ux/09-interaction-patterns.md) | Loading, error, empty, destrutiva |
| [`docs/70-ux/10-accessibility.md`](docs/70-ux/10-accessibility.md) | WCAG 2.2 AA |
| [`docs/70-ux/11-copy-deck-skip-messages.md`](docs/70-ux/11-copy-deck-skip-messages.md) | Mensagens humanizadas |
| [`docs/70-ux/12-screen-live-event-console.md`](docs/70-ux/12-screen-live-event-console.md) | Console ao vivo (Sprint 8) |
| [`docs/70-ux/13-tutorial-instalacao-tracking.md`](docs/70-ux/13-tutorial-instalacao-tracking.md) | Tutorial completo de instalação (GA4 + Pixel + tracker.js + WP Rocket) |

### 80 — Roadmap
| Arquivo | Conteúdo |
|---|---|
| [`docs/80-roadmap/00-sprint-0-foundations.md`](docs/80-roadmap/00-sprint-0-foundations.md) | Sprint 0 |
| [`docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md`](docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md) | Sprint 1 |
| ... | Sprints 2-8 |
| [`docs/80-roadmap/97-ownership-matrix.md`](docs/80-roadmap/97-ownership-matrix.md) | **Ownership por path** |
| [`docs/80-roadmap/98-test-matrix-by-sprint.md`](docs/80-roadmap/98-test-matrix-by-sprint.md) | Tests por sprint |
| [`docs/80-roadmap/99-acceptance-criteria-by-sprint.md`](docs/80-roadmap/99-acceptance-criteria-by-sprint.md) | DoD por sprint |

### 90 — Meta
| Arquivo | Conteúdo |
|---|---|
| [`docs/90-meta/01-doc-conventions.md`](docs/90-meta/01-doc-conventions.md) | Convenções de doc |
| [`docs/90-meta/02-id-registry.md`](docs/90-meta/02-id-registry.md) | Registro de IDs (anti-duplicata) |
| [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md) | OQ-* abertas |
| [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) | ADRs |
| [`docs/90-meta/05-subagent-playbook.md`](docs/90-meta/05-subagent-playbook.md) | Protocolo paralelo (detalhe) |
| [`docs/90-meta/06-spec-driven-process.md`](docs/90-meta/06-spec-driven-process.md) | Metodologia |

### Raiz (operacional)
| Arquivo | Quem lê |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Subagents (contrato base invariante) |
| `CLAUDE.md` (este) | Orquestrador (você) |
| [`MEMORY.md`](MEMORY.md) | Humano + orquestrador (estado de sessão) |
| [`TESTING.md`](TESTING.md) | Subagent de teste |
| [`README.md`](README.md) | Visitante novo |

---

## 2. Decision tree — qual subagent invocar

| Gatilho na T-ID | Subagent |
|---|---|
| Toca em `packages/db/src/schema/`, migrations, RLS | `globaltracker-schema-author` |
| Implementa BR pura, lead resolver, attribution, idempotency, consent, PII helpers (`apps/edge/src/lib/`) | `globaltracker-domain-author` |
| Cria/edita rotas HTTP, middleware, validação Zod (`apps/edge/src/routes/`, `middleware/`) | `globaltracker-edge-author` |
| Adapter outbound Meta CAPI / Google Ads / GA4 (`apps/edge/src/dispatchers/`) | `globaltracker-dispatcher-author` |
| Adapter inbound Hotmart/Stripe/Kiwify/etc (`apps/edge/src/routes/webhooks/`) | `globaltracker-webhook-author` |
| `tracker.js` front-end (`apps/tracker/`) | `globaltracker-tracker-author` |
| Testes unit/integration/E2E (`tests/`) | `globaltracker-test-author` |
| Review pré-merge / auditoria de BRs em código | `globaltracker-br-auditor` |
| Sincroniza doc canônica após mudança de código | `globaltracker-docs-sync` |
| Exploração / pesquisa multi-domínio (read-only) | `Explore` |
| Tarefa que não cabe em nenhum custom | `general-purpose` |

**Regra**: sempre prefira subagent customizado quando aplicável. Se T-ID atravessa múltiplos módulos, **decomponha em sub-T-IDs por subagent** antes de despachar.

---

## 3. Protocolo de paralelização

Detalhe completo em [`docs/90-meta/05-subagent-playbook.md`](docs/90-meta/05-subagent-playbook.md). Resumo operacional:

```
Para cada onda da sprint:
  1. Selecione N T-IDs com parallel-safe=yes e ownership disjunto.
  2. Decomponha cada uma em subagent + escopo.
  3. Despache N Agent calls EM UMA SÓ MENSAGEM (paralelo).
  4. Aguarde TODAS terminarem.
  5. Rode pnpm typecheck && pnpm lint && pnpm test.
  6. Verde: docs-sync (subagent), marca completed em MEMORY.md §5.
  7. Vermelho: corrija ANTES da próxima onda.
```

**Limites:**
- Máximo **3-5 T-IDs por onda** (evita conflito de raciocínio do orquestrador).
- Mudanças em `docs/30-contracts/` são **sempre serial** (sozinhas na onda).
- Migrations destrutivas são **sempre serial** + aprovação humana.

---

## 4. Como compor prompt do subagent

Subagent **não tem** seu mapa completo da doc. Você entrega só o que ele precisa.

### Template mínimo

```
[T-ID]: T-N-NNN
[Tipo]: schema | domain | edge | dispatcher | webhook | tracker | test
[Ownership]: paths exatos que pode editar
[Critério de aceite]: <da T-ID na sprint>

[Carga de contexto - leia nesta ordem]:
1. AGENTS.md (regras invariantes que você honra)
2. .claude/agents/<nome-do-subagent>.md (seu próprio escopo)
3. <docs/20-domain/NN-mod-X.md> — módulo da T-ID (foco em §3, §7, §10, §12)
4. <BRs específicas referenciadas — só os arquivos, não a pasta>
5. <docs/30-contracts/NN.md> — contratos consumidos
6. <linha exata da T-ID em docs/80-roadmap/NN.md>

[BRs aplicáveis]: BR-X-NNN, BR-Y-MMM (cite no código)
[INVs aplicáveis]: INV-MOD-NNN
[Não tocar]: <paths fora do ownership>
[Saída esperada]: <arquivos a criar/editar; comandos a rodar>
```

### O que NÃO entregar

- Mapa completo da doc (este arquivo)
- Roadmap completo (só a linha da T-ID)
- Lista dos outros subagents (irrelevante para o worker)
- Decisões de orquestração (paralelização, próxima onda)

---

## 5. Comandos de verificação (entre ondas)

```bash
pnpm typecheck            # tsc --noEmit em todos pacotes
pnpm lint                 # eslint
pnpm test                 # vitest unit + integration
pnpm test:e2e             # playwright (apenas no fim do sprint)
pnpm db:generate          # drizzle migrations diff
pnpm build                # cf workers build (smoke)
```

DoD inclui pelo menos `typecheck` + `lint` + `test` verdes.

---

## 6. Comandos proibidos sem aprovação humana

| Comando | Motivo |
|---|---|
| `git push -f` em `main` | Sobrescrever histórico publicado |
| `git reset --hard` | Perde trabalho não-commitado |
| `pnpm db:reset` / `drizzle-kit drop` | Apaga dados |
| `wrangler delete` em recursos prod | Desliga produção |
| Edição em `docs/30-contracts/**` em T-ID que não é `contract-change` | Quebra contratos consumidos |
| Edição fora do ownership declarado | Viola paralelização |
| `npm install` em vez de `pnpm` | Quebra workspace |

---

## 7. Quando pedir decisão ao humano

Use `AskUserQuestion` quando:

- Decisão técnica entre 2-3 opções equivalentes (sem ADR existente).
- Decisão envolve trade-off de UX/produto.
- Decisão envolve segurança (PII, auth) — não despache subagent até resposta.
- Decisão envolve dinheiro (custo de provedor, tier).
- Conflito entre docs canônicos.
- Subagent reportou OQ aberta — confirme antes de seguir.

Se decisão tem ADR existente que parece se aplicar: aplique e cite ADR; se incerto, pergunte antes.

---

## 8. Conformidade de stack — protocolo de bloqueio

Se um item da stack não funciona conforme esperado (você ou subagent reportou):

```
PARE → DOCUMENTE → ESCALE
1. Pare a onda.
2. Documente em MEMORY.md §1 como [STACK-BLOQUEIO]:
   - Item da stack
   - Comportamento esperado
   - Comportamento observado
   - Hipótese
   - Tentativas feitas
3. Devolva controle ao humano com resumo.
```

**Não tente workaround silencioso** (ex.: trocar `pnpm` por `npm`, `Hyperdrive` por `pg` direto). Workarounds disfarçam o problema e quebram quando outro subagent entra.

---

## 9. Skills disponíveis

- **Built-in Claude Code**: bash, file ops, Read/Edit/Write, ToolSearch, Agent
- **Skills custom** em `.claude/skills/`:
  - `design-system` — extrai tokens de URL externa (típico fluxo: regenera `DESIGN.md` no root → atualizar [`docs/70-ux/01-design-system-tokens.md`](docs/70-ux/01-design-system-tokens.md))
- **Subagents custom** em `.claude/agents/` (ver §2)
- **MCP servers**: nenhum por default no projeto
- **Playwright (MCP)**: se `mcp__playwright__browser_*` retornar `Browser is already in use for <path>`, **mate o processo dono** antes de tentar novamente — outra sessão Claude pode ter deixado o Chrome ocupando o profile. Comando: `pkill -f "user-data-dir=<path>"` (substituir `<path>` pelo diretório do erro, ex: `/Users/tiagomenna/Library/Caches/ms-playwright/mcp-chrome-1ead15c`). Depois reinvocar a ferramenta de browser. Não esperar/pedir confirmação — é fluxo operacional padrão.

---

## 10. Interação com memória

- [`MEMORY.md`](MEMORY.md) na raiz do repo é fonte canônica de **estado de sessão** — leia §5 antes de propor próximo passo.
- `~/.claude/projects/.../memory/` (memória cross-session do agente) tem preferências do usuário e ponteiros — leia ao iniciar sessão nova.
- Decisões importantes nunca ficam em MEMORY — migram para [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) (ADR).
- OQs nunca ficam em MEMORY — migram para [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md).

---

## 11. Doc-sync

Toda mudança de comportamento atualiza doc canônica **no mesmo commit**. Tabela "código → doc obrigatória" em [`docs/90-meta/05-subagent-playbook.md §8`](docs/90-meta/05-subagent-playbook.md). Quando impossível, registre `[SYNC-PENDING]` em `MEMORY.md §2` com prazo (até final do sprint).

Despache `globaltracker-docs-sync` ao final de toda onda que mudou comportamento mas não atualizou doc.

---

## 12. Antes de iniciar qualquer trabalho

Checklist do orquestrador ao começar uma sessão:

1. Ler [`MEMORY.md §5`](MEMORY.md) — estado atual.
2. `git status` + `git log -10` — confirmar branch + commits recentes.
3. Verificar P0 pendências em `MEMORY.md §5` — bloqueiam a sprint atual?
4. Identificar próxima onda no sprint ativo (`docs/80-roadmap/<sprint>.md`).
5. Verificar `parallel-safe=yes` + ownership disjunto das T-IDs candidatas.
6. Decompor cada T-ID em subagent + prompt dirigido.
7. Despachar.
