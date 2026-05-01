# 01 — Brief executivo

## 1. Nome

**GlobalTracker**

## 2. Em uma frase

Plataforma interna de tracking, atribuição e dispatch server-side para Meta Ads, Google Ads, GA4 e webhooks de plataformas de venda em lançamentos de infoprodutos — com identidade de retorno, consent granular e privacidade por design.

## 3. Problema

Operação de mídia paga em lançamentos sofre cinco classes de problema, todas custosas:

1. **Configuração manual repetitiva.** A cada lançamento, o time refaz tags, GTM, pixels server-side, eventos custom, deduplicação Pixel↔CAPI, links rastreáveis, dashboards e públicos — em ferramentas fragmentadas. O custo é horas; o risco é configuração inconsistente entre lançamentos.

2. **Eventos perdidos silenciosamente.** Sem persistência idempotente entre browser, webhook e plataformas de mídia, retries de Hotmart/Stripe criam duplicatas em Meta CAPI, falhas 5xx do Google somem sem retry, e dispatch direto durante o request não tem auditoria. ROAS calculado em cima de dados incompletos vira decisão errada de budget.

3. **Identidade fragmentada.** Lead se cadastra com email-only, retorna via outro device com phone-only, depois converte com email+phone — sistemas tradicionais ou criam duplicatas ou travam por unique constraint. Em retornos no mesmo device, o tracker não reconhece o lead e dispara `InitiateCheckout` para Meta CAPI sem `user_data` enriquecido, perdendo qualidade de match.

4. **PII em logs e payloads.** Email/telefone aparecem em logs de aplicação, em jsonb de eventos, em payloads de erro — risco regulatório (LGPD/GDPR) e operacional (vazamento via terceiros que recebem o log).

5. **Customer Match Google quebrando.** A partir de abril/2026, novos adotantes via Google Ads API não são aceitos para Customer Match; recomendação oficial é Data Manager API. Sistemas que tratam Google como dispatcher genérico vão quebrar silenciosamente.

GlobalTracker resolve os cinco problemas em uma plataforma única, com Runtime de tracking independente da UI e do orchestrator.

## 4. Usuários-alvo

- **Quem usa:** profissional de marketing operando lançamentos (PERSONA-MARKETER).
- **Quem paga:** dono(a) de operação digital ou empresa de infoprodutos contratando o GlobalTracker como ferramenta interna.
- **Quem opera:** dev/devops interno responsável por configurar domínios, secrets, deploys (PERSONA-OPERATOR).
- **Quem administra privacidade:** operador de privacidade/compliance que recebe SARs e audita retenção (PERSONA-PRIVACY-OFFICER).
- **Quem é trackeado:** lead/visitante que interage com LPs e fluxos de checkout (PERSONA-LEAD) — sujeito da política de consent.

Detalhe completo em [`03-personas-rbac-matrix.md`](03-personas-rbac-matrix.md).

## 5. Resultado esperado para a Fase 1

Ao final da Fase 1 (Sprint 1), o GlobalTracker tem:

- Schema completo no Postgres/Supabase, com migrations versionadas, incluindo todas as tabelas auxiliares (`lead_aliases`, `lead_merges`, `lead_tokens`, `audience_snapshots`, `audit_log`, `raw_events`).
- Edge Worker rodando em modo "fast accept": `/v1/config`, `/v1/events`, `/v1/lead`, `/r/:slug` aceitam requests, validam token público, validam Zod schema, aplicam clamp de `event_time`, persistem em `raw_events` e retornam 202 em < 50ms (RNF-001).
- Endpoint admin `DELETE /v1/admin/leads/:lead_id` stub (SAR), pronto para ser completado na Fase 4.
- Contratos Zod compartilhados em `packages/shared/`.
- Smoke test do Worker passando; testes unitários básicos de schema; CI rodando typecheck + lint + test em cada PR.

A Fase 1 **não** entrega ainda: ingestion processor funcional, dispatch para Meta/Google, tracker.js, webhooks reais. Esses entram nas Fases 2–3.

## 6. Objetivos principais

- **OBJ-001 — Tracking confiável e auditável.** 100% dos eventos aceitos pelo Edge devem ser rastreáveis até dispatch (`succeeded` / `failed` / `skipped` / `dead_letter`) ou rejeitados explicitamente. Zero perda silenciosa.
- **OBJ-002 — Identidade unificada de retorno.** Lead que retorna ao mesmo domínio dentro de 60 dias deve ser reconhecido e seus eventos dispatchados a Meta CAPI / Google Ads com `user_data` enriquecido server-side, sem o browser reenviar PII.
- **OBJ-003 — Atribuição correta por lançamento.** First-touch e last-touch por `(lead_id, launch_id)` calculados a partir de attribution params capturados client-side e replayados em `/v1/lead`. CPL/CPA por anúncio com granularidade de `account_id × campaign_id × adset_id × ad_id × creative_id × placement`.
- **OBJ-004 — Privacidade por design.** PII (email, phone, name) sempre hashada + criptografada com chave por workspace. IP e UA transitórios. Retenção e SAR explícitos. Logs sanitizados.
- **OBJ-005 — Consent granular e auditável.** Cinco finalidades de consent capturadas e snapshot por evento. Dispatch bloqueado em destinos cujo consent não foi concedido.
- **OBJ-006 — Conformidade futura com Customer Match Google.** Estratégia condicional (`google_data_manager` default; `google_ads_api_allowlisted` quando elegível; `disabled_not_eligible` quando não); sistema continua funcionando após mudança 2026 sem retrabalho.
- **OBJ-007 — Operação multi-tenant escalável.** Cada cliente é um workspace com `workspace_id` em todas as tabelas, RLS no Postgres, rate limit por workspace, e crypto key derivada por HKDF.
- **OBJ-008 — Latência de ingestão sub-50ms p95.** Edge Worker no modelo fast accept retorna 202 em < 50ms; processamento normalizado é assíncrono.

OBJs ligam-se a RFs em [`02-problem-goals.md`](02-problem-goals.md).

## 7. Fora de escopo da Fase 1

| Item | Quando entra |
|---|---|
| Ingestion processor funcional (raw_events → events normalizado) | Fase 2 |
| `tracker.js` em produção | Fase 2 |
| Cookie `__ftk` + `lead_token` HMAC | Fase 2 |
| Dispatch para Meta CAPI | Fase 2 |
| Webhooks Hotmart/Stripe/Kiwify | Fase 2 |
| Cost ingestor (Meta/Google) | Fase 3 |
| GA4 Measurement Protocol | Fase 3 |
| Google Ads Conversion Upload + Enhanced Conversions | Fase 3 |
| Customer Match (Data Manager API) | Fase 3 |
| Audience sync com snapshots materializados | Fase 3 |
| `visitor_id` + retroactive linking multi-touch | Fase 3 |
| Control Plane (UI operacional) | Fase 4 |
| Trigger.dev orchestrator (deploy de LP, provisioning de campanhas) | Fase 5 |
| LP Generator com IA + dashboard custom Next.js realtime | Fase 6 |
| Modelagem estatística de atribuição (MMM, multi-touch incremental) | Fora de escopo total |
| Otimização automática de budget | Fora de escopo total |
| Criação autônoma irrestrita de campanhas sem aprovação humana | Fora de escopo total |
| Enriquecimento de dados por terceiros | Fora de escopo total |
| Suporte universal a qualquer plataforma de checkout sem adapter homologado | Fora de escopo total |

## 8. Restrições

| Categoria | Restrição |
|---|---|
| **Stack** | Cloudflare Workers + Hono + Postgres/Supabase + Drizzle + CF Queues + CF KV + Cron Triggers. Trigger.dev só Fase 5. Frontend Next.js 15 (Fase 4). LP templates Astro (Fase 5). Tracker TS vanilla < 15 KB gzipped. Decisão registrada em [ADR-001](../90-meta/04-decision-log.md#adr-001--stack-canônica). |
| **Compliance** | LGPD (Brasil) e GDPR (UE quando aplicável). Direito de erasure (Art. 17 GDPR / Art. 18 LGPD) implementado via endpoint admin. Consent por finalidade auditável. |
| **Idioma** | Documentação em português (operador BR). Identificadores de código em inglês. Conventional Commits em inglês. Copy de UI em português. |
| **Performance** | RNF-001 — `/v1/events` p95 < 50ms no Edge. RNF-002 — Disponibilidade Runtime 99,5% no MVP, evoluir para 99,9%. |
| **Privacidade** | Nenhum log de aplicação ou dispatch payload pode conter PII em claro. Sanitização centralizada obrigatória. |
| **Multi-tenancy** | Isolamento lógico por `workspace_id` em todas tabelas + RLS no Postgres. Crypto key derivada por workspace via HKDF. |
| **Escopo MVP** | Apenas 1 workspace operando em produção na Fase 2. Multi-workspace operacional na Fase 4. |

## 9. Riscos iniciais

Lista resumida — riscos detalhados com mitigação em [`planejamento.md` Seção 29](../../planejamento.md):

| Risco | Probabilidade | Impacto |
|---|---:|---:|
| Google Ads mal configurado gerar dados incorretos | Alta | Alto |
| LP externa com Pixel próprio duplicar eventos sem `event_id` compartilhado | Média | Alto |
| Webhook sem identidade forte não associar Purchase ao lead | Média | Alto |
| Lead merge automático fundir leads diferentes | Média | Médio/alto |
| `__ftk` vazar via XSS em LP externa | Média | Médio/alto |
| FX rate impreciso degradar ROAS | Média | Médio |
| `raw_events` crescer sem controle | Baixa | Médio |
| PII vazar em logs | Baixa/média | **Muito alto** |
| Page token rotation quebrar snippets em produção | Média | Alto |

Cada risco tem mitigação registrada — ver [Seção 29 do `planejamento.md`](../../planejamento.md) e ADRs correspondentes.

## 10. Premissas iniciais

Hipóteses não validadas que sustentam o desenho atual. Se quebrarem, schema/contrato precisa rever.

- **ASSUMP-001** — Operador BR é o usuário primário; idioma de UI/docs em português é prioridade. *Validação:* OK no contexto atual.
- **ASSUMP-002** — Lançamentos típicos têm volume entre 10k e 1M de eventos/dia por workspace. *Validação:* a confirmar com primeiro lançamento real; dimensiona retenção e custo de KV.
- **ASSUMP-003** — TTL de 60 dias para `__ftk` é suficiente para reidentificação típica em janela de lançamento. *Validação:* configurável por workspace; ajustar com base em métricas.
- **ASSUMP-004** — Workspace começa com 1 lançamento ativo por vez (sequencial). Suporte a múltiplos lançamentos paralelos é não-crítico no MVP. *Validação:* schema já suporta — só impacta UX da Fase 4.
- **ASSUMP-005** — Plataformas de checkout primárias são Hotmart, Kiwify e Stripe; outras (Eduzz, etc.) entram via adapter homologado posterior. *Validação:* OK por escopo da Fase 2.
- **ASSUMP-006** — Cliente final aceita LP externa com Pixel já existente que pode coexistir com tracker via política `coexist_with_existing_pixel`. *Validação:* implementação prevê 3 modos; ajustar se cenário for diferente.
- **ASSUMP-007** — FX rate diária do ECB é confiável para BRL/USD/EUR. *Validação:* OQ-001 aberta — operador pode trocar provedor.
- **ASSUMP-008** — Cookie `__ftk` first-party com `SameSite=Lax` funciona em todos navegadores-alvo (últimas 2 versões majors de Chrome, Safari, Firefox, Edge). *Validação:* testado em Sprint 2.
- **ASSUMP-009** — Lead com email exato + phone exato é a mesma pessoa (premissa para merge). *Validação:* heurística pode ser ajustada — ver OQ-006.
- **ASSUMP-010** — Operador prefere falha explícita (job `skipped` com `skip_reason`) a falha silenciosa. *Validação:* base do design de `dispatch_jobs`.
