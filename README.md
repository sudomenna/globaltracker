# GlobalTracker

> Plataforma interna de **tracking, atribuição e envio server-side** para Meta Ads, Google Ads, GA4 e webhooks de plataformas de venda — pensada para lançamentos de infoprodutos.

---

## Para o leigo: o que é e por que existe

Quando alguém clica em um anúncio, navega numa landing page, preenche um formulário e
finalmente compra um curso, **muita coisa precisa ser registrada e enviada de volta** para
plataformas como Meta Ads, Google Ads e Google Analytics. Sem isso:

- O Meta não sabe quem comprou → não consegue otimizar a campanha
- O Google Ads não consegue creditar a venda → você acha que o anúncio não dá retorno
- O time de marketing não sabe qual canal trouxe o lead → decisões viram chute

Hoje, configurar tudo isso a cada lançamento é trabalhoso e frágil:
GTM, pixel, server-side tracking, eventos, webhooks de Hotmart/Stripe, sincronização de
públicos, dashboards… cada lançamento começa do zero.

**O GlobalTracker resolve isso de forma centralizada e reusável**:

1. **Captura** o que acontece em landing pages, links de campanha e webhooks de venda.
2. **Identifica** o lead (mesmo se ele aparecer primeiro com email e depois com telefone).
3. **Atribui** a origem correta (Meta? Google? orgânico?).
4. **Envia** o evento para Meta CAPI, GA4 Measurement Protocol e Google Ads Conversion Upload — tudo server-side, com deduplicação, retry e auditoria.
5. **Sincroniza** públicos (Custom Audiences / Customer Match) automaticamente.
6. **Mostra** dashboards de funil, custos, ROAS e CPL.

### Em uma frase

> Um Meta Pixel + GA4 + Google Ads + Hotmart + Stripe **unificados em um único pipeline**, com privacidade por design e sem precisar configurar do zero a cada lançamento.

### Quem usa

- **MARKETER** — cria lançamento, registra LP, vê dashboards, consulta saúde de integrações.
- **OPERATOR** — instala tracking, mantém integrações funcionando, debuga falhas.
- **ADMIN** — gerencia workspace, membros, permissões.
- **PRIVACY** — atende SAR (LGPD/GDPR), audita acesso a PII.

### Exemplo de fluxo (visão simplificada)

```
1. Lead clica no anúncio do Meta com fbclid=ABC
       ↓
2. Redirector resolve link curto → 302 para a LP
       ↓
3. tracker.js (no <head> da LP) captura UTMs, fbclid, gclid, cookies fbc/fbp
       ↓
4. Lead preenche formulário → tracker dispara POST /v1/lead
       ↓
5. Edge Worker valida, persiste em raw_events, retorna 202 em < 100ms
       ↓
6. Processor async: identifica/cria lead, atribui first-touch, normaliza evento
       ↓
7. Cria dispatch_jobs para cada destino elegível (Meta CAPI, GA4 MP, Google Ads)
       ↓
8. Workers de dispatch enviam ao Meta/Google/GA4 com retry, idempotência e dedup
       ↓
9. MARKETER vê o lead aparecer no dashboard, com timeline visual de cada despacho
```

Detalhe completo em [`docs/60-flows/02-capture-lead-and-attribute.md`](docs/60-flows/02-capture-lead-and-attribute.md).

---

## Estado atual

**Pré-Sprint 0**: documentação spec-driven completa; código ainda não iniciado.

A pirâmide de specs em [`docs/`](docs/) cobre produto → arquitetura → domínio → contratos →
integrações → BRs → flows → UX → roadmap. Pendências para iniciar implementação estão em
[`MEMORY.md §5`](MEMORY.md). O roadmap completo é Sprint 0 → Sprint 8, descrito em
[`docs/80-roadmap/`](docs/80-roadmap/).

---

## Pontos de entrada

| Quem você é | Comece por |
|---|---|
| **Curioso / leigo** | a seção acima ("Para o leigo") + [`docs/00-product/01-brief.md`](docs/00-product/01-brief.md) |
| **Humano novo no time** | [`docs/00-product/01-brief.md`](docs/00-product/01-brief.md) → [`docs/00-product/06-glossary.md`](docs/00-product/06-glossary.md) → [`docs/10-architecture/01-overview.md`](docs/10-architecture/01-overview.md) |
| **Orquestrador (main agent Claude Code)** | [`CLAUDE.md`](CLAUDE.md) — mapa completo + decision tree + paralelização |
| **Subagent (worker)** | [`AGENTS.md`](AGENTS.md) — contrato base + `.claude/agents/<nome>.md` (escopo) |
| **Vai implementar uma T-ID** | [`docs/80-roadmap/`](docs/80-roadmap/) → módulo em [`docs/20-domain/`](docs/20-domain/) → BRs/contratos referenciados |
| **Vai configurar tracking de uma LP** | (Sprint 6+) onboarding wizard em [`docs/70-ux/03-screen-onboarding-wizard.md`](docs/70-ux/03-screen-onboarding-wizard.md) |
| **Quer entender uma decisão técnica** | [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) (ADRs) |
| **Quer ver perguntas em aberto** | [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md) (OQs) |
| **Vai operar produção** | [`MEMORY.md §5`](MEMORY.md) + [`docs/10-architecture/07-observability.md`](docs/10-architecture/07-observability.md) |
| **Vai testar** | [`TESTING.md`](TESTING.md) |

---

## Stack

| Camada | Tecnologia | Status |
|---|---|---|
| Edge HTTP | Cloudflare Workers + Hono | Sprint 1+ |
| Database | Postgres (Supabase) + Drizzle | Sprint 1+ |
| Filas | Cloudflare Queues | Sprint 1+ |
| Cache | Cloudflare KV | Sprint 1+ |
| Crons | CF Cron Triggers | Sprint 1+ |
| Tracker JS | TS vanilla, < 15 KB gzip | Sprint 2+ |
| Validação | Zod em todas fronteiras | Sprint 1+ |
| Control Plane (UI) | Next.js 15 + shadcn/ui | Sprint 6+ |
| Workflows | Trigger.dev | Sprint 7+ |
| Analytics dashboards | Metabase | Sprint 3+ |
| AI / LP generator | Claude API | Sprint 8+ |

Detalhe e justificativas em [`docs/10-architecture/02-stack.md`](docs/10-architecture/02-stack.md) e [ADR-001](docs/90-meta/04-decision-log.md).

---

## Princípios arquiteturais

1. **Runtime independente.** O backend (Edge + dispatchers) funciona sozinho. Control Plane (UI) e Orchestrator (workflows) são aceleradores, não dependências.
2. **Privacy by design.** PII em 3 categorias (hash, encrypted, transient). SAR (Subject Access Request) via endpoint admin. Consent granular por finalidade.
3. **Idempotência em todas camadas.** Replay protection no Edge; `event_id` determinístico em webhooks; `idempotency_key` por destino para envios.
4. **Multi-tenant por `workspace_id`.** Row-Level Security no Postgres. Chave criptográfica derivada por workspace via HKDF.
5. **Contracts-first.** Pasta [`docs/30-contracts/`](docs/30-contracts/) é fonte única de contratos HTTP/eventos. Mudanças aqui são serializadas e sincronizadas.
6. **Doc-sync no mesmo commit.** Código e docs evoluem juntos. Auditor automatizado checa BRs citadas em código.

---

## Setup

### Pré-requisitos

| Ferramenta | Versão mínima | Observação |
|---|---|---|
| Node.js | 20 LTS | Recomendado via `nvm` ou `fnm` |
| pnpm | 9+ | `npm install -g pnpm` |
| Wrangler CLI | 3+ | `pnpm add -g wrangler` |
| Supabase CLI | 1.150+ | Para DB local (`supabase start`) |
| Docker | qualquer recente | Necessário para Supabase CLI local |
| Conta Cloudflare | — | Workers + KV + Queues + Hyperdrive |

### Primeiros passos

```bash
# 1. Clone e instale dependências
git clone git@github.com:sudomenna/globaltracker.git
cd globaltracker
pnpm install

# 2. Configure variáveis de ambiente
cp apps/edge/.dev.vars.example apps/edge/.dev.vars
# edite apps/edge/.dev.vars com suas credenciais locais

# 3. Suba banco de dados local
supabase start          # Postgres + Realtime local
pnpm db:push            # aplica schema (migrations Drizzle)

# 4. Suba o Worker em modo dev
pnpm --filter @globaltracker/edge dev   # wrangler dev local

# 5. Verifique saúde
pnpm typecheck          # deve retornar sem erros
pnpm lint               # deve retornar sem erros
pnpm test               # testes unit + integration
```

Variáveis de ambiente necessárias estão documentadas em `apps/edge/.dev.vars.example`. Secrets de produção são gerenciados via `wrangler secret put`.

---

## Comandos rápidos (válidos a partir do Sprint 0)

```bash
pnpm install        # primeira vez
pnpm typecheck      # tsc --noEmit em todos pacotes
pnpm lint           # ESLint/Biome
pnpm test           # unit + integration (Vitest)
pnpm test:e2e       # Playwright (final do sprint)
pnpm db:generate    # gerar migrations Drizzle
pnpm dev:edge       # wrangler dev no Worker
pnpm build          # build de todos pacotes
```

Detalhe e estratégia de testes em [`TESTING.md`](TESTING.md).

---

## Estrutura de pastas

```
.
├── apps/                        # (a partir de Sprint 0)
│   ├── edge/                    # Cloudflare Worker — entrypoint HTTP /v1/*
│   ├── tracker/                 # tracker.js — bundle instalado em LPs
│   ├── control-plane/           # Next.js — UI operacional (Sprint 6+)
│   ├── orchestrator/            # Trigger.dev — workflows complexos (Sprint 7+)
│   └── lp-templates/            # Astro — geração assistida de LPs (Sprint 8+)
├── packages/
│   ├── shared/                  # contratos Zod, types compartilhados
│   └── db/                      # schema Drizzle + migrations
├── tests/                       # unit / integration / e2e / fixtures
├── docs/                        # pirâmide canônica de specs
│   ├── 00-product/              # brief, personas, glossário, métricas
│   ├── 10-architecture/         # overview, stack, observabilidade, NFRs
│   ├── 20-domain/               # módulos (MOD-*), entidades, invariantes
│   ├── 30-contracts/            # APIs HTTP, webhook, módulos
│   ├── 40-integrations/         # Meta CAPI, GA4 MP, Google Ads, webhooks
│   ├── 50-business-rules/       # BR-* canônicas
│   ├── 60-flows/                # casos de uso end-to-end
│   ├── 70-ux/                   # IA, padrões de interação, screens
│   ├── 80-roadmap/              # sprints 0-8, ownership matrix
│   └── 90-meta/                 # convenções, ID registry, ADRs, OQs, processo
├── .claude/
│   └── agents/                  # subagents customizados
├── AGENTS.md                    # contrato base lido por TODO subagent (worker)
├── CLAUDE.md                    # playbook do orquestrador (main agent Claude Code)
├── MEMORY.md                    # estado volátil de sessão (não canônico)
├── TESTING.md                   # guia operacional de testes
└── README.md                    # este arquivo
```

---

## Compliance e privacidade

- **LGPD (Brasil)** — controlador é o operador; GlobalTracker é operador (de dados).
- **GDPR (EU)** — quando workspace atende residentes UE.
- **Direito de erasure** — endpoint admin `DELETE /v1/admin/leads/:id`. Anonimização completa em < 30 dias.
- **Audit log** — retenção 7 anos. Toda mutação sensível e acesso a PII em claro é registrado.
- **Zero PII em logs** — sanitização centralizada via middleware.
- **Consent granular** — 5 finalidades (analytics, marketing, ad_user_data, ad_personalization, customer_match). Snapshot por evento.

Detalhe em [`docs/50-business-rules/BR-PRIVACY.md`](docs/50-business-rules/BR-PRIVACY.md) e [`docs/50-business-rules/BR-CONSENT.md`](docs/50-business-rules/BR-CONSENT.md).

---

## Como contribuir

1. **Se você é orquestrador** (main agent Claude Code), leia [`CLAUDE.md`](CLAUDE.md) — mapa completo da doc, decision tree de qual subagent invocar, protocolo de paralelização.
2. **Se você é subagent** (worker dispatchado pelo orquestrador), leia [`AGENTS.md`](AGENTS.md) (contrato base) + seu próprio arquivo em [`.claude/agents/<nome>.md`](.claude/agents/) (escopo específico).
3. **Toda mudança de comportamento** atualiza doc canônica no mesmo commit (regra "doc-sync"). Se impossível, registre em `MEMORY.md §2` com prazo.
4. **Toda BR aplicada em código** tem comentário citando a BR (`// BR-IDENTITY-005: ...`).
5. **Toda T-ID** tem ownership declarado e cabe em UM PR.
6. **Stack-bloqueio** (ferramenta não funciona como esperado): pare, documente em `MEMORY.md §1`, devolva controle ao humano. Não faça workaround silencioso.

Para implementação assistida por IA, o orquestrador segue [`CLAUDE.md`](CLAUDE.md), os subagents seguem [`AGENTS.md`](AGENTS.md), e a paralelização é detalhada em [`docs/90-meta/05-subagent-playbook.md`](docs/90-meta/05-subagent-playbook.md).

---

## Licença

Projeto interno — propriedade de Outsiders Digital. Uso restrito conforme acordo com o time.

---

## Autoria e referências

Documentação especificada usando metodologia spec-driven com subagents (descrita em [`docs/90-meta/06-spec-driven-process.md`](docs/90-meta/06-spec-driven-process.md)). Documento input arquivado em [`docs/90-meta/archive/planning-v3.md`](docs/90-meta/archive/planning-v3.md).
