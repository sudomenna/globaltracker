# 03 — Open Questions Log

Perguntas abertas extraídas de `planejamento.md` v3.0 e da conversa de revisão arquitetural (2026-05-01). Cada OQ classifica impacto e se bloqueia alguma fase.

> **Política:** OQ aberta não vira invenção em código. Se bloqueia uma T-ID, a T-ID fica em status `blocked` até a OQ virar ADR ou ser descartada.

---

## OQ-001 — Provedor exato de FX para normalização cambial

- **Origem:** `planejamento.md` Seção 20.1, env `FX_RATES_PROVIDER`.
- **Contexto:** sistema converte `spend_cents` em `spend_cents_normalized` para ROAS cross-currency. Provedores candidatos: ECB (gratuito, oficial, atualização diária), Wise (API paga, taxa real de mercado), manual (operador insere).
- **Pergunta:** qual provedor é default para Fase 3? Como tratar workspaces sem internet ao provedor escolhido?
- **Impacto se decidir errado:** ROAS impreciso, retrabalho em `MOD-COST`.
- **Status:** **FECHADA — Sprint 4 (2026-05-02).**
- **Decisão:** ECB como provider default (`FX_RATES_PROVIDER=ecb`). Moeda base de normalização: BRL (já default em `workspaces.fx_normalization_currency`). Sistema implementa os 3 providers (ecb/wise/manual); ECB suficiente para dashboards de marketing. Wise reservado para caso de precisão financeira contábil futura.
- **Classificação:** pode esperar (relevante apenas na Fase 3 — Sprint 4).

---

## OQ-002 — Política exata de retenção por categoria

- **Origem:** `planejamento.md` Seção 10.1, RNF-013.
- **Contexto:** valores propostos (events 13m, dispatch_attempts 90d, logs 30d, raw_events 7d, audit_log 7y) são defaults razoáveis mas não validados juridicamente.
- **Pergunta:** o operador de privacidade do workspace confirma esses prazos para LGPD/GDPR? Há requisito legal específico do segmento (infoprodutos) que altere?
- **Impacto se decidir errado:** não-conformidade ou custo de armazenamento desnecessário.
- **Status:** aberta.
- **Classificação:** pode esperar (Fase 4 — quando UI de privacidade entra).

---

## OQ-003 — Estratégia de `client_id` GA4 quando `_ga` ausente

- **Origem:** `planejamento.md` Seção 16.1.
- **Contexto:** se a LP não tem GA4 client-side, sistema mintera `client_id` próprio derivado de `__fvid`. Mas isso quebra continuidade com qualquer GA4 web property pré-existente do operador. Alternativas: (a) só dispatchar GA4 quando `_ga` cookie presente; (b) mintar próprio aceitando descontinuidade; (c) deixar configurável por workspace.
- **Pergunta:** qual default? Documentar trade-off ao operador?
- **Impacto se decidir errado:** relatórios GA4 server-side descolados de relatórios web do cliente.
- **Status:** **FECHADA — Sprint 4 (2026-05-02). Decisão: opção B.**
- **Decisão:** mintar `client_id` próprio derivado de `__fvid` no formato compatível GA4 (`GA1.1.<8digits>.<10digits>`). Trade-off documentado na UI do Control Plane. Ver OQ-012 para caso edge de checkout direto via plataforma (Digital Manager Guru) sem passagem pela LP.
- **Classificação:** pode esperar (Fase 3 — Sprint 4).

---

## OQ-004 — Bot mitigation: Turnstile vs honeypot puro vs Captcha

- **Origem:** `planejamento.md` Seção 9 (Bot mitigation mínima).
- **Contexto:** três opções: (a) honeypot + tempo mínimo de submit (sem dependência externa); (b) Cloudflare Turnstile (gratuito, integra com CF Workers, exige snippet no client); (c) reCAPTCHA (Google, dependência externa).
- **Pergunta:** Turnstile como default obrigatório, ou opt-in por página? Como degrada em rede instável?
- **Impacto se decidir errado:** spam de bot scrapers em `/v1/lead` desde dia 1 de produção.
- **Status:** **FECHADA → ADR-024** (2026-05-01).
- **Classificação:** bloqueante para produção — implementar no Sprint 2 antes do go-live de `/v1/lead`.
- **Decisão:** Cloudflare Turnstile como camada principal; honeypot como camada complementar futura (backlog).

---

## OQ-005 — Tiers de rate limit por workspace (RNF-011)

- **Origem:** `planejamento.md` RNF-011.
- **Contexto:** rate limit por workspace previne tenant problemático esgotar quotas Meta/Google globais. Mas qual o limite default? Como diferenciar tenants pagos vs free? Como subir limite sob demanda?
- **Pergunta:** tabela inicial de tiers (req/min por rota, eventos/dia por workspace).
- **Impacto se decidir errado:** ou bloqueia tenant legítimo, ou deixa tenant abusivo passar.
- **Status:** aberta.
- **Classificação:** pode esperar (Fase 2 pode usar limite único generoso; tier real só na Fase 4).

---

## OQ-006 — Heurísticas para flag manual de merge automático

- **Origem:** `planejamento.md` Seção 11.6 (algoritmo de resolução com merge).
- **Contexto:** quando 2+ leads convergem, sistema funde automaticamente o canonical (mais antigo). Mas há cenários ambíguos: emails diferentes mas mesmo phone (família compartilhando número?), email idêntico mas phone diferente em workspaces diferentes (não merge cross-tenant, mas ainda assim flag?).
- **Pergunta:** quais sinais geram `flag_for_review` em vez de merge automático? Threshold de antiguidade entre leads (ex.: > 1 ano → revisão manual)?
- **Impacto se decidir errado:** ou merges errados (perda de dados de identidade), ou flags excessivas (operador soterrado).
- **Status:** aberta.
- **Classificação:** pode esperar (Fase 1 implementa merge sem flag; flag adicionado em Fase 2 ou 4).

---

## OQ-007 — Storage de `lead_token`: stateful (`lead_tokens` table) ou stateless puro (HMAC)

- **Origem:** `planejamento.md` Seção 11.6 (`lead_tokens` table marcada como opcional).
- **Contexto:** HMAC stateless é mais simples (sem lookup), mas não permite revogação granular (precisa rotacionar `LEAD_TOKEN_HMAC_SECRET` para revogar tudo). Stateful permite revogação por `lead_id` mas exige lookup em todo `/v1/events`.
- **Pergunta:** stateless puro é aceitável para Fase 2? Ou precisa de stateful desde o início para suportar SAR (erasure deve revogar tokens existentes)?
- **Impacto se decidir errado:** se stateless e descobrirmos que precisa revogar, refactor tem custo.
- **Status:** **FECHADA — 2026-05-01.** Decisão: **stateful** (`lead_tokens` table). Motivo: LGPD/SAR exige revogação granular por lead; custo de lookup via KV é aceitável. Ver ADR a registrar.
- **Classificação:** pode esperar — ainda não implementamos. Decidir antes do Sprint 2.

---

## OQ-008 — Brand color primary do GlobalTracker

- **Origem:** [`docs/70-ux/01-design-system-tokens.md §10`](../70-ux/01-design-system-tokens.md).
- **Contexto:** spec de design system adotou tokens extraídos de referência visual Attio (em [`/DESIGN.md`](../../DESIGN.md)). `color.text.tertiary=#4e8cfc` está sendo usado como accent provisório, mas brand primary do GlobalTracker (logo, identidade visual, CTAs primários) ainda não foi definido.
- **Pergunta:** qual cor primária? Deve coexistir com tokens dark mode (`#000`/`#1a1d21`/`#15181c`).
- **Impacto se decidir errado:** retrabalho de tema antes do launch da UI; potencial inconsistência com brand book (se vier).
- **Status:** aberta.
- **Classificação:** pode esperar (Sprint 6 inicia com tokens atuais; brand finaliza durante Fase 4).

---

## OQ-009 — Fonte de display/headings

- **Origem:** [`docs/70-ux/01-design-system-tokens.md §10`](../70-ux/01-design-system-tokens.md).
- **Contexto:** spec atual usa Inter para tudo (texto e headings). Alternativa: Inter para body + display font (ex.: Inter Display, Cabinet Grotesk) para headings/heroes.
- **Pergunta:** Inter único ou par de fontes? Custo de carregamento adicional vale o impacto visual?
- **Impacto se decidir errado:** retrabalho de typography scale.
- **Status:** aberta.
- **Classificação:** pode esperar (Sprint 6 inicia com Inter solo; revisão estética em Fase 4 final).

---

## OQ-010 — Suporte a modo light no Control Plane

- **Origem:** [`docs/70-ux/01-design-system-tokens.md §2.1`](../70-ux/01-design-system-tokens.md).
- **Contexto:** Control Plane é dark-mode-only no Sprint 6. Operadores frequentemente trabalham em horários variados; alguns ambientes (apresentações, prints para auditoria) ficam melhor em light. Skill de design system não extraiu light tokens.
- **Pergunta:** light mode é requisito de Fase 4 ou pode aguardar Fase 6+? Se sim, definir token semântico paralelo.
- **Impacto se decidir errado:** se necessário antes do esperado, refactor de tokens.css duplicando tudo.
- **Status:** aberta.
- **Classificação:** pode esperar (Fase 6+ — não bloqueia Sprint 6).

---

## OQ-011 — Criação de dispatch_jobs pelo processor sem configuração de integração

- **Origem:** T-2-006 — raw-events-processor Sprint 2.
- **Contexto:** `dispatch_jobs` exige `destination`, `destination_account_id`, `destination_resource_id` (todos `notNull`). A tabela de configuração de integrações por workspace ainda não existia (Sprint 3+). Sem essa config não era possível criar `dispatch_jobs` com valores reais.
  - Alternativa A: criar jobs com valores placeholder (`'pending_config'`) — viola semântica da tabela.
  - Alternativa B: skip silencioso quando payload não incluir `dispatch_config` — `dispatch_jobs_created=0`; processor retorna success sem jobs.
  - Alternativa C: `MOD-DISPATCH.createDispatchJobs(event, ctx)` é a interface correta — implementar no Sprint 3.
- **Decisão:** Alternativa B foi adotada no Sprint 2 (skip silencioso). No Sprint 3, implementada a tabela `workspace_integrations` com coluna `guru_api_token` (migration 0021) e `createDispatchJobs` em `apps/edge/src/lib/dispatch.ts`. Processor pode agora criar jobs reais a partir da config de integração por workspace.
- **Status:** **FECHADA — Sprint 3 (2026-05-02).**
- **Classificação:** bloqueante para feature completa de dispatch — resolvida.

---

## OQ-012 — GA4 client_id para comprador que chega direto no checkout do Digital Manager Guru

- **Origem:** decisão de OQ-003 (Sprint 4, 2026-05-02).
- **Contexto:** o fluxo principal é: visitante acessa LP → tracker.js grava `__fvid` + captura `_ga` cookie → clica no CTA → vai para o checkout do Guru → compra. Nesse fluxo, o `client_id` GA4 está disponível (via `_ga` ou via `__fvid` mintado).
  O caso edge é: comprador cai **direto na página de checkout do Guru** sem passar pela LP (ex.: link direto compartilhado, remarketing direto para checkout, busca orgânica do produto). Nesse cenário, o tracker.js nunca rodou, `__fvid` não existe, `_ga` pode não existir, e o GlobalTracker não tem `client_id` para associar à compra.
- **Pergunta:** como tratar compras via webhook Guru onde não há `client_id` GA4 disponível?
  - Alternativa A: dispatchar GA4 com `client_id` gerado aleatoriamente (UUID) — cria sessão fantasma no GA4, distorce relatórios mas não perde o evento de Purchase.
  - Alternativa B: skip do dispatch GA4 para essa compra com `skip_reason='no_client_id'` — compra não aparece no GA4, mas não distorce relatórios.
  - Alternativa C: tentar correlacionar por email hash com uma visita anterior na LP (lookup em `events` por `lead_id + event_name=PageView`) — usa o `client_id` da visita anterior se encontrada dentro de uma janela de tempo.
  - Alternativa D: configurável por workspace — operador decide.
- **Impacto:** volume de compras "diretas" pode ser baixo no início, mas cresce com remarketing e indicações. Decisão errada distorce ROAS no GA4.
- **Status:** **FECHADA → ADR-032 (2026-05-07).**
- **Decisão:** Alternativa D — cascata 4 níveis (`self` → `sibling` → `cross_lead` phone→email → `deterministic` via `lead_id`). Implementada em `apps/edge/src/dispatchers/ga4-mp/client-id-resolver.ts` (`resolveClientIdExtended`); DB lookups de sibling/cross_lead em `buildGa4DispatchFn`. Skip `no_client_id_unresolvable` só quando `lead_id` ausente.
- **Classificação:** resolvida em Sprint 16 Onda 2.

---

## OQ-013 — dispatch-replay: criar novo job vs. resetar job existente

- **Origem:** divergência detectada em 2026-05-02 entre contrato e implementação.
- **Contrato** (`docs/30-contracts/05-api-server-actions.md`):
  - Body: `{ justification: string }`
  - Response: **202** + `{ new_job_id, status: 'queued' }`
  - Side effect: cria **novo** `dispatch_job` com `replayed_from_dispatch_job_id` (histórico completo preservado)
- **Implementação** (`apps/edge/src/routes/dispatch-replay.ts`):
  - Body: `{ reason: string }`
  - Response: **200** + `{ queued: true, job_id, destination }`
  - Side effect: **reseta** o job existente (`status='pending'`, `attempt_count=0`) — histórico de tentativas perdido
- **Pergunta:** qual comportamento adotar?
  - **Opção A — seguir o contrato:** criar novo `dispatch_job` filho do original. Preserva histórico completo de todas as tentativas. Requer coluna `replayed_from_dispatch_job_id` no schema (migration nova). Mais auditável.
  - **Opção B — atualizar o contrato:** manter o reset do job existente. Mais simples, sem migration. Adequado se auditoria de tentativas individuais não for necessária para o produto.
- **Impacto:** se Opção A, precisar de migration + ajuste do schema `dispatch_jobs` + refatoração do route + testes. Se Opção B, atualizar `05-api-server-actions.md` e remover o SYNC-PENDING.
- **Não bloqueia** nenhum sprint ativo (Sprint 8).
- **Status:** **FECHADA — Sprint 8 (2026-05-02). Decisão: Opção A → ADR-025.**
- **Decisão:** Criar novo `dispatch_job` filho com `replayed_from_dispatch_job_id`. Preserva histórico completo. Migration 0026 adicionou a coluna. T-8-009 refatorou a route.

---

## OQ-014 — HMAC validation pendente para webhook OnProfit

- **Origem:** entrega do adapter OnProfit no Sprint 17 (commit `59003f9`, deploy `1e905322`, 2026-05-09).
- **Contexto:** `apps/edge/src/routes/webhooks/onprofit.ts` foi entregue em produção sem validação HMAC do header de assinatura porque OnProfit ainda não publicou a spec do header. Hoje o webhook está protegido apenas por:
  1. Conhecimento do **slug do workspace** no query string (`?workspace=outsiders`).
  2. Restrição da OnProfit (no painel deles) sobre qual conta posta para qual URL.
  Handler loga `event: 'onprofit_webhook_hmac_validation_todo'` em todo request como reminder operacional.
- **Pergunta:** quando OnProfit publicar a spec, qual padrão adotar?
  - Alternativa A: espelhar `timingSafeTokenEqual` usado em `apps/edge/src/routes/webhooks/hotmart.ts` (HMAC-SHA256 com shared secret armazenado em `workspace_integrations`).
  - Alternativa B: validação por API token fixo no body (padrão Guru — `payload.api_token` lookup contra `workspace_integrations.guru_api_token`). Aplicável apenas se OnProfit colocar o secret no body em vez de header.
- **Impacto se decidir errado:** janela de exposição enquanto o spec não chega; um terceiro com conhecimento do slug pode injetar Purchases falsos, inflando ROAS dashboards e poluindo `lead_stages`. Mitigação atual: slug é privado e a URL não é divulgada publicamente.
- **Status:** aberta. Bloqueada por terceiro (OnProfit).
- **Classificação:** pode esperar — não bloqueia sprint atual, mas precisa fechar antes de promover OnProfit como integração suportada para outros workspaces. Tracking em `MEMORY.md §3 / ONPROFIT-HMAC-VALIDATION-TODO`.

---

## OQ-015 — Race condition `_fbp` cookie no tracker.js

- **Origem:** validação prod 2026-05-09 do hardening EMQ Meta CAPI.
- **Contexto:** Lead `d3359f5f` (LP `wk-societarios-1`) mostrou que o cookie `_fbp` apareceu **3 minutos depois** do PageView que tracker.js disparou. Causa: snippets WordPress das LPs (`wk-societarios-1` LP de captação + `wk-obg` LP obrigado) estão **incompletos** — não chamam `fbq('consent', 'grant')` + `fbq('track', 'PageView')` síncronos imediatamente após `fbq('init', '149334790553204')`. Sem isso, o cookie `_fbp` só é setado depois que `fbevents.js` async termina, gerando race condition vs `tracker.js` (também async). Hoje mitigado parcialmente pelo enrichment histórico server-side (ADR-039), mas o evento `Lead` server-side perde o `fbp` real do session inicial.
- **Pergunta:** qual é a estratégia robusta?
  - Alternativa A (curto prazo): operador atualiza o snippet das 2 LPs WP para chamar `fbq` síncrono. Pendência humana — `MEMORY.md §3 / PIXEL-SNIPPET-LP-FIX`.
  - Alternativa B (médio prazo): `tracker.js` faz retry/aguarda janela curta de 500ms-1s antes de enviar `Lead`/`PageView`, dando tempo do `_fbp` aparecer. Risco: aumenta latência percebida de captura; pode atrasar redirect pós-form.
  - Alternativa C: `tracker.js` mintera `_fbp` próprio (formato `fb.1.<timestamp>.<random>`) quando o cookie não estiver presente após X ms. Risco: duplicidade — se Pixel terminar de inicializar depois e setar o cookie real, teremos `_fbp` divergente entre browser e server.
  - Alternativa D: tracker observa `document.cookie` em loop curto (até 2s) e re-envia o evento server-side com `fbp` populado. Custo: 1 extra request por evento.
- **Impacto:** sem fix, eventos Lead capturados na primeira sessão chegam sem `fbp`, dependendo do enrichment histórico que só funciona se o lead voltar. Match score Lead fica em ~6/8 em vez de 7/8.
- **Status:** aberta. Mitigação Alternativa A em curso (operador). Decisão sobre B/C/D fica para próxima iteração do tracker se Alternativa A não bastar.
- **Classificação:** pode esperar — Alternativa A resolve sem mudança de código.

---

## Política de promoção OQ → ADR

OQ vira ADR quando:
1. Decisão for tomada com base técnica + input do stakeholder relevante.
2. Houver alternativas consideradas registradas.
3. Consequências (positivas e negativas) forem listadas.
4. Impacto em MOD-*/CONTRACT-*/BR-* for mapeado.

OQ é descartada quando:
1. Pergunta deixar de ser relevante (escopo mudou).
2. Decisão equivalente já existir em outro ADR (referenciar e fechar).
