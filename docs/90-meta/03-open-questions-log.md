# 03 — Open Questions Log

Perguntas abertas extraídas de `planejamento.md` v3.0 e da conversa de revisão arquitetural (2026-05-01). Cada OQ classifica impacto e se bloqueia alguma fase.

> **Política:** OQ aberta não vira invenção em código. Se bloqueia uma T-ID, a T-ID fica em status `blocked` até a OQ virar ADR ou ser descartada.

---

## OQ-001 — Provedor exato de FX para normalização cambial

- **Origem:** `planejamento.md` Seção 20.1, env `FX_RATES_PROVIDER`.
- **Contexto:** sistema converte `spend_cents` em `spend_cents_normalized` para ROAS cross-currency. Provedores candidatos: ECB (gratuito, oficial, atualização diária), Wise (API paga, taxa real de mercado), manual (operador insere).
- **Pergunta:** qual provedor é default para Fase 3? Como tratar workspaces sem internet ao provedor escolhido?
- **Impacto se decidir errado:** ROAS impreciso, retrabalho em `MOD-COST`.
- **Status:** aberta.
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
- **Status:** aberta.
- **Classificação:** pode esperar (Fase 3 — Sprint 4).

---

## OQ-004 — Bot mitigation: Turnstile vs honeypot puro vs Captcha

- **Origem:** `planejamento.md` Seção 9 (Bot mitigation mínima).
- **Contexto:** três opções: (a) honeypot + tempo mínimo de submit (sem dependência externa); (b) Cloudflare Turnstile (gratuito, integra com CF Workers, exige snippet no client); (c) reCAPTCHA (Google, dependência externa).
- **Pergunta:** Turnstile como default obrigatório, ou opt-in por página? Como degrada em rede instável?
- **Impacto se decidir errado:** spam de bot scrapers em `/v1/lead` desde dia 1 de produção.
- **Status:** aberta.
- **Classificação:** **bloqueante** para Fase 2 (Sprint 2) — `/v1/lead` precisa de mitigação ativa antes de ir para produção.

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
- **Status:** aberta. **Recomendação técnica:** stateful desde o início (custo de uma query KV é baixo, e SAR exige revogação).
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

## Política de promoção OQ → ADR

OQ vira ADR quando:
1. Decisão for tomada com base técnica + input do stakeholder relevante.
2. Houver alternativas consideradas registradas.
3. Consequências (positivas e negativas) forem listadas.
4. Impacto em MOD-*/CONTRACT-*/BR-* for mapeado.

OQ é descartada quando:
1. Pergunta deixar de ser relevante (escopo mudou).
2. Decisão equivalente já existir em outro ADR (referenciar e fechar).
