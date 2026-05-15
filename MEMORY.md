# MEMORY.md

> **Estado de sessão volátil — não é fonte canônica.**
> - Decisões → [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) (ADR)
> - Open Questions → [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md)
> - Histórico de ondas/sprints → `git log` + `docs/80-roadmap/<sprint>.md`
> - Limpeza periódica esperada — preserve apenas o que afeta a próxima sessão.

---

## §1 Estado atual

- **Sprint ativo**: manutenção. Última sessão 2026-05-14 fechou incidente Hyperdrive + observabilidade + Meta cost ingestor.
- **Branch**: `main`. Sincronizado com `origin/main` — todos os commits da sessão pushed.
- **Branch cockpit**: `traffic-cockpit/sprint-tc-1-foundation` — TC-1 + TC-2 implementados. Não tocado nesta sessão.
- **Edge prod**: deploy atual **`6b12d3a7`** (Meta currency fix + cron yesterday+today + observability dashboard, 2026-05-14). Comando: **`pnpm deploy:edge`**.
- **Hyperdrive prod**: ativo desde 2026-05-13 — binding `34681cabdb954437ba6db304a235da87`, aponta para Supavisor pooler `aws-1-sa-east-1.pooler.supabase.com:5432` (session mode), user `postgres.kaxcmhfaqrxwnpftkslj`. Worker prefere Hyperdrive sobre `DATABASE_URL` secret (ADR-046 — **HYPERDRIVE first, DATABASE_URL fallback**, nunca inverter). Smoke test pós-mudança: `bash scripts/maintenance/webhook-smoke-test.sh`.

### Entregas 2026-05-14 — Incidente Hyperdrive + observability + Meta cost ingestor

Sessão única, commit `149fbed` (12 arquivos, 654 +/31 −) + doc-sync `c48d345`. Três blocos independentes resolvidos no mesmo dia.

#### Bloco 1 — Incidente Hyperdrive (16h de outage silencioso de webhooks)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 1 | **Diagnóstico**: Meta Events Manager mostrava último Purchase há 16h. Causa: 3 rotas webhook (`/v1/webhook/guru`, `/v1/webhooks/sendflow`, `/v1/webhooks/onprofit`) ficaram com ordem antiga `DATABASE_URL ?? HYPERDRIVE` após codemod do dia 13 — cast `(env as unknown as Bindings)` bloqueou o regex match. `DATABASE_URL` secret estava divergente do Hyperdrive binding → 500 silencioso nas 3 rotas | `149fbed` | `5656a816` |
| 2 | **Fix**: invertido para HYPERDRIVE first, DATABASE_URL fallback nas 3 rotas. ADR-046 já existia. | (incluso) | (incluso) |
| 3 | **Bug colateral**: `apps/edge/src/routes/webhooks/guru.ts` referenciava `requestId` sem declarar → ReferenceError em payloads sem api_token. Declarado no entry do handler. | (incluso) | (incluso) |
| 4 | **Prevenção**: novo `scripts/maintenance/webhook-smoke-test.sh` — POST junk em cada endpoint, espera 4xx. INV-INFRA-001 documentada em ADR-046. Validado verde em prod 2026-05-13 e 14. | (incluso) | (incluso) |
| 5 | **Recovery de vendas perdidas**: user mandou 50+ payloads via mirror n8n; replay via `POST /v1/webhooks/onprofit` com idempotency `sha256(orderId+status)` — todos OK. Limitação: Meta atribuição prejudicada (eventos chegaram com delay → "Atualidade dos dados: por hora" no Events Manager). Match quality 9.2/10. | (manual) | — |

#### Bloco 2 — Observability (dashboard de saúde de integrações)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 6 | **Endpoint**: `GET /v1/dashboard/stats` ganhou `integrations.{inbound,outbound}`. Provider classificado via marker no `raw_events.payload` (`_guru_event_id`, `_onprofit_event_type`, `_provider='sendflow'`, `_hotmart_event_type`). Thresholds: ok < 2h, warn 2-6h, down > 6h (omit se count_7d < 5). | `149fbed` | `5656a816` |
| 7 | **UI**: `IntegrationsBanner` (vermelho global se algum provider down) + `IntegrationsHealthCard` (semáforo por provider). KpiCard "Faturamento" pinta vermelho se `leads ≥ 5 && buyers === 0` (funnel-gap signal). | (incluso) | (incluso) |
| 8 | **"Última compra"** coluna ordenável em `/contatos` — derivada `MAX(events.event_time)` para Purchase, NULLS LAST. `last_purchase_at` em `LeadListItem`. Conversão defensiva `Date` ou `string` (postgres.js retorna agregação como string). | (incluso) | (incluso) |

#### Bloco 3 — Meta cost ingestor (Investimento R$ 7K vs Ads Manager R$ 11.6K)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 9 | **Bug 1**: `MetaInsightRowSchema` strippava `account_currency` → fallback hardcoded `'USD'` mesmo em conta BRL. Adicionado `account_currency: z.string().optional()` ao schema. | `149fbed` | `5656a816` → `6b12d3a7` |
| 10 | **Bug 2**: Meta API omite `account_currency` em algumas rows agregadas. `cost-ingestor.ts` agora varre o batch e cacheia a primeira currency válida em `batchAccountCurrency`, usada como fallback no resolveMetaRowCurrency. | (incluso) | (incluso) |
| 11 | **Bug 3**: `upsertAdSpend` ON CONFLICT DO UPDATE não incluía `currency` → re-ingestões deixavam lixo histórico (rows antigas USD permaneciam USD). Adicionado `currency = EXCLUDED.currency`. | (incluso) | (incluso) |
| 12 | **Bug 4**: cron `30 17 * * *` coletava apenas o dia em andamento → capturava só ~14h iniciais, nunca re-fetchava a noite (perdia 30-90% do gasto diário). Mudado para coletar `yesterday (full UTC) + today (partial snapshot)`. | (incluso) | (incluso) |
| 13 | **Backfill** 08-14 mai via `POST /v1/admin/cost-backfill?date=YYYY-MM-DD` (rota pré-existente). 76 rows BRL após fix; total R$ 11.638,23 (antes R$ 7.019,03). Match com Ads Manager validado. | (manual) | — |

**Doc-sync** (commit `c48d345`): `docs/30-contracts/05-api-server-actions.md` (dashboard-stats shape + last_purchase_at), `docs/10-architecture/07-observability.md` (Saúde Integrações + smoke test), `docs/40-integrations/12-fx-rates-provider.md` (account_currency authority), `docs/20-domain/10-mod-cost.md` (cron yesterday+today), `docs/90-meta/04-decision-log.md` (ADR-046 follow-up).

### Entregas 2026-05-13 sessão 1 (esta sessão) — Infra Hyperdrive + PII identity hardening

#### Bloco 1 — Recuperação PII master key + Hyperdrive em prod (manhã)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 1 | **Diagnóstico**: UI `/contatos` mostrava `—` em vez de email/telefone. Root cause: `apps/edge/.dev.vars` tinha `PII_MASTER_KEY_V1` em **base64** mas código `hexToBytes()` esperava **hex** → chave de 22 bytes lixo → decrypt silenciosamente falhava. Prod tinha hex correto no CF secret. Provado via round-trip local — script reencrypta com chave lixo, decripta OK; mas não decripta o ciphertext de prod | — | — |
| 2 | **Recovery**: endpoint admin temporário `/v1/admin/recover-secret` (POST + Bearer token timing-safe) deployado, secret `ADMIN_PII_RECOVERY_TOKEN` posto via wrangler. User executou curl, salvou hex `e630e2b1...2dd2` em vault + `.dev.vars` + `.env.local`. Endpoint + secret removidos imediatamente após (versão `1d25838e`). Pattern de "admin endpoint temporário" estabelecido — usável de novo se necessário | (route via deploy) | `ef74bb42` → `1d25838e` |
| 3 | **Hyperdrive WIP da sessão anterior commitado**: `wrangler.toml` Hyperdrive ID `39156b9...` → `34681c...` (config refeita pelo user com host Supavisor `aws-1-sa-east-1.pooler.supabase.com:5432`). `packages/db/src/index.ts` ganhou `sanitizeConnStr()` (workerd retorna `/` raw na senha, postgres.js rejeita). `apps/edge/package.json` pinou `wrangler@^4.90.1` devDep | `cbb4c2c` | `88d2be68` |
| 4 | **Priorizar Hyperdrive sobre DATABASE_URL** — 43 substituições em 15 arquivos `apps/edge/src/**` via codemod. Padrão `env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString` → `env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL`. `DATABASE_URL` agora é fallback se Hyperdrive cair (mas `??` não pega exceção em runtime — rollback necessário se Hyperdrive incident) | `246ce83` | `404d4fea` |

#### Bloco 2 — Bug 1 (`pii_enc drift`) — ADR-044 (tarde)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 5 | **Diagnóstico**: lead "Bruna" mostrava email `bruna@sgm.adv.br` na UI, mas `lead_aliases` tinha esse email **superseded** e `bruna.siagino@gmail.com` ativo. Causa: `pii-enrich.ts` tinha cláusula `WHERE … OR isNull(email_enc) OR …` — só escrevia em campo NULL. Após primeira escrita, `email_enc` ficava efetivamente imutável, mesmo com identifier mudando (cenário 4 do BR-IDENTITY-001) | — | — |
| 6 | **Auditoria workspace `outsiders`**: 16 leads com drift (7 email, 9 phone) — 5.7% do total. Casos legítimos: Pedro (typo fix `.con` → `.com`), Bruna (novo gmail), 9 phones (provavelmente reconciliação do "9" extra brasileiro) | — | — |
| 7 | **ADR-044** + extensão BR-IDENTITY-001 cenário 4 + ampliação INV-IDENTITY-008 — `*_enc` espelha identifier ativo, não snapshot imutável | `a1b0768` | (doc only) |
| 8 | **Fix em `pii-enrich.ts`** — agora decripta `*_enc` atual com `pii_key_version` da row, compara com input plaintext: igual → noop; diferente → re-encripta com `currentVersion` e overwrite; decrypt fail → skip (preserva ciphertext recuperável). Idempotente. 6 testes unit cobrindo todos os paths | `4fc0928` | `e2c3be30` |
| 9 | **Backfill** dos 16 leads em drift via `scripts/maintenance/backfill_pii_enc_drift.mjs` — varre `raw_events.payload` procurando plaintext que bate com `leads.email_hash`/`phone_hash` atual, re-encripta. 16/16 resolvíveis, aplicados. Re-audit: drift = 0 | — (script gitignored) | (DB-only update) |
| 10 | **Validação E2E**: UI da Bruna mostra agora `bruna.siagino@gmail.com` (correto). Bug 1 fechado | — | — |

#### Bloco 3 — Bug 2 (`last_seen_at` drift) — ADR-045 (noite)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 11 | **Diagnóstico**: Bruna's `leads.last_seen_at = 12/05 20:51 BRT` mas `MAX(events.event_time) = 11/05 13:33 BRT` — drift de 31h. Causa: `event_id` de cart_abandonment usa `sha256(onprofit:cart_abandonment:offer_hash:email)` — dois carts da Bruna na mesma offer colidiram → dedup-skip no `raw-events-processor` Step 7 → mas `resolveLeadByAliases` (Step 3) já tinha bumpado `last_seen_at` via GREATEST. **Side-effects rodam antes da dedup check** | — | — |
| 12 | **Auditoria**: 281 leads ativos, 251 em sync, 22 com drift (>5s), apenas **2 com drift > 1h** (Bruna, Teste). Confirmado pela auditoria de raw_events: 42 cart_abandonments em 3 dias, 42 `payload.id` distintos, **zero re-deliveries pelo OnProfit**. Order bumps já vêm inline em `payload.orderbumps[]` — não precisa dedup-by-key | — | — |
| 13 | **ADR-045** documentando decisão de mudar dedup key de `(offer_hash, email)` para `id` apenas. Mais alinhado com BR-WEBHOOK-002 canônico | `10f14b9` | (doc only) |
| 14 | **Fix em `onprofit/mapper.ts`** — `deriveOnProfitCartAbandonmentEventId(id)` (signature reduzida de 3 args pra 1). Single caller atualizado. 8 testes unit cobrindo idempotência, distinção, regression do bug | `0937ae4` | `aae05007` |
| 15 | **Decisão consciente de NÃO backfillar 35 cart_abandonments dedup-skipados pré-fix** — risco de re-disparar Meta CAPI / Google Ads como conversões falsas. Aceitar drift histórico (impacto: ~2 leads visivelmente afetados, ROAS intacto). Documentado em ADR-045 §Consequências | — | — |

#### Resumo Edge prod 2026-05-13

| Deploy | O quê | Reversível |
|---|---|---|
| `ef74bb42` | admin recover endpoint | ✅ removido em `1d25838e` |
| `1d25838e` | admin endpoint removido | — |
| `88d2be68` | Hyperdrive ID `34681c...` + sanitizeConnStr | rollback possível mas Hyperdrive antigo `39156b9...` foi deletado em CF |
| `404d4fea` | Hyperdrive prioritized over DATABASE_URL | `wrangler rollback` se Hyperdrive der incident |
| `e2c3be30` | pii-enrich overwrite semantics | `wrangler rollback` reverte comportamento |
| `aae05007` | cart_abandonment dedup-by-id | `wrangler rollback` reverte fórmula |

---

### Entregas 2026-05-12 sessão 3 (sessão anterior)

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 1 | **Verificação**: 32 raw_events cart_abandonment confirmados `processed`. 5 `failed` pré-fix com payload sem email — não recuperáveis, descartados | — | — |
| 2 | **Meta CAPI `event_source_url`**: adicionado ao mapper e ao `buildMetaCapiDispatchFn`. Prioridade: `event.pageId` → lookup direto da page URL; fallback: primeira `role='sales'` com URL não-nula do launch. Query params stripados. DEBT documentada para múltiplas sales pages | `731f74a` | `6dbb2223` |

---

### Entregas 2026-05-12 sessão 2

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 1 | Dashboard "Hoje" usa meia-noite BRT em vez de janela rolante 24h. Label "24h" → "Hoje". Sub-text Investimento: "Hoje" em vez de `R$/dia` no período hoje | `31029d6` | `b0b8c0e5` |
| 2 | IC consolidation: `aggregatePurchaseValueByGroup` estendido com `eventName` param — agora agrupa InitiateCheckout da mesma compra além de Purchase | `183eaf1` | `b0b8c0e5` |
| 3 | IC consolidation nos 4 dispatchers (Meta CAPI, GA4, GAds conv, Enhanced) — condição `eventName === 'Purchase' OR eventName === 'InitiateCheckout'` | `183eaf1` | `b0b8c0e5` |
| 4 | Timeline UI (`journey-tab.tsx`): `mergePurchaseGroups` agrupa também InitiateCheckout com `GROUPABLE_EVENT_NAMES = Set(['Purchase','InitiateCheckout'])`. Group key = `${tgId}:${name}` separa os dois tipos | `183eaf1` | — |
| 5 | **BUG FIX**: `handleCartAbandonment` nunca chamava `QUEUE_EVENTS.send()` — 32 raw_events ficaram presos como `failed`. Fix: `.returning({id})` + `QUEUE_EVENTS.send({ platform:'onprofit' })` | `9c6f804` | `b0b8c0e5` |
| 6 | **Suppression**: dispatch de cart_abandonment suprimido quando Purchase existe para mesmo `email_hash` + `launch_id` nos últimos 6h. Insere como `discarded/suppressed_by_purchase`. Cobre 3 casos observados de CA pós-PAID (27–125 min) | `9c6f804` | `b0b8c0e5` |
| 7 | **Replay**: 32 raw_events (status `failed`) do cart_abandonment re-enfileirados via CF Queue REST API com `platform:'onprofit'` — processados por `processOnprofitRawEvent` (não genérico). Script: `scripts/maintenance/replay-cart-abandonment.ts` | `3b257cc` | — (script) |

**Cart abandonment fix — resumo técnico**:
- **Causa raiz**: `handleCartAbandonment` não enfileirava com `platform:'onprofit'` → outbox poller enfileirava sem `platform` → consumer caía no `processRawEvent` genérico → Zod validation error em `event_id/event_name/event_time` (ausentes no payload OnProfit).
- **Supressão**: `leadAliases JOIN events` por `identifier_type='email_hash'` + `event_name='Purchase'` + `event_time > now()-6h`. Não bloqueia CA sem PAID prévio.
- **32 replays**: todos em launch `d0a4e10e` (wkshop-cs-jun26). Sem migration necessária.

**IC server-side ativo**:
- Guru `waiting_payment` (PIX/boleto) → `InitiateCheckout` ✓
- Guru `abandoned` (carrinho abandonado) → `InitiateCheckout` ✓
- OnProfit `WAITING` (PIX/boleto/cada OB) → `InitiateCheckout` ✓ (cada webhook = event_id único, agrega value)
- OnProfit `cart_abandonment` → `InitiateCheckout` ✓ (agora enfileira corretamente + suprime se PAID)
- **CDN tracker.js**: R2 `gt-tracker-cdn` etag `991734d4`, 9466 bytes (race fix).
- **DB Supabase**: `kaxcmhfaqrxwnpftkslj` (sa-east-1, org CNE Ltda). Migrations 0000–**0050** aplicadas. **Sem migration nova** nesta sessão.
- **Cloudflare plan**: Workers Paid ativo desde 2026-05-09 17:05 UTC ($5/mês). KV quota agora mensal (~1M writes/mês), não daily. Padrão canônico (ADR-040): TODO `kv.put()` é best-effort.
- **DEV_WORKSPACE**: `74860330-a528-4951-bf49-90f0b5c72521` (Outsiders Digital → slug=`outsiders`).
- **Match score Meta CAPI**: 7/8 → **8/8 alcançável** (validado: 15 Purchases em score 8 nos últimos 7 dias).

### Entregas 2026-05-12 sessão 1

| # | Tema | Commit | Deploy |
|---|---|---|---|
| 1 | Guru `waiting_payment` → `InitiateCheckout` (era SKIP) — PIX/boleto gera IC com PII completo | `1700514` | `680f729c` |
| 2 | `custom:click_buy_workshop` + `custom:click_buy_main` → `INTERNAL_ONLY_EVENT_NAMES` — não geram mais `dispatch_jobs` para nenhum destino | `1700514` | `680f729c` |
| 3 | Mappers Meta CAPI + GA4 limpos (entradas click_buy_* removidas) | `1700514` | `680f729c` |
| 4 | Docs: `00-event-name-mapping.md` + `13-digitalmanager-guru-webhook.md` atualizados | `1700514` | — |
| 5 | Dashboard home CP (`page.tsx`) + `GET /v1/dashboard/stats` | anterior | `11d94a7c` |

**Impacto esperado no Event Manager Meta**: count de IC cai (191 → apenas ICs com origem real em webhook), coverage de em/ph/fn/ln sobe de 17.56% → próximo de 100%.

### OnProfit Consolidated Dispatch — o que foi entregue (2026-05-10, Waves 1–8)

| Wave | Entrega | Arquivos |
|---|---|---|
| 1 | Tipos OnProfit: `item_type`, `offer_hash`, `transactions`, `custom_fields` union | `integrations/onprofit/types.ts`, `mapper.ts`, Zod schema no processor |
| 2 | Seed 3 produtos OnProfit no catálogo + `launch_products` para wkshop-cs-jun26 | SQL direto (sem migration) |
| 3 | Processor: `deriveTransactionGroupId`, persiste `item_type`+`transaction_group_id` em `custom_data`, skip dispatch para `order_bump` | `onprofit-raw-events-processor.ts` |
| 4 | Helper `aggregatePurchaseValueByGroup` + Meta CAPI consolida valor + delay 80s no CF Queue | `lib/transaction-aggregator.ts`, `index.ts` |
| 5 | Mesma agregação em GA4, Google Ads Conversion e Enhanced Conversions | `index.ts` (3 dispatch fns) |
| 6 | Endpoint `GET /v1/leads/:id/purchases` + aba "Compras" no lead detail CP | `routes/leads-purchases.ts`, CP `purchases-tab.tsx`, `page.tsx` |
| 7 | Tag rule `purchased_order_bump` adicionada ao blueprint de `wkshop-cs-jun26` | SQL UPDATE direto no banco |
| 8 | 11 testes unitários: `transaction-aggregator.test.ts` + `onprofit-order-bump-dispatch.test.ts` + fixtures | `tests/` |

**Padrão `transaction_group_id`**: `sha256(workspaceId:emailNorm:offerHash:bucket5min)[:32]`. Todos os webhooks da mesma compra (main + OBs) compartilham o mesmo hash. Dispatcher espera 80s (CF Queue `delaySeconds`) para OBs chegarem, depois soma `custom_data.amount` de todos os events do grupo.

**Dívida futura Guru**: documentada em `memory/project_dispatch_consolidation_pattern.md` cross-session. Guru tem `is_order_bump` no payload — quando OBs ficarem comuns lá, replicar o mesmo padrão em `guru-raw-events-processor.ts`.

### Entregas 2026-05-11 (esta sessão)

| # | Tema | Deploy |
|---|---|---|
| 1 | Contrato canônico `CartAbandonmentInternalEvent` em `shared/cart-abandonment.ts` | — |
| 2 | Cart abandonment OnProfit (`object: 'cart_abandonment'`) — novo endpoint + mapper | `7787c9fd` |
| 3 | Hotmart `PURCHASE_OUT_OF_SHOPPING_CART` → `InitiateCheckout` | `7787c9fd` |
| 4 | Guru `abandoned` → formalizado no contrato canônico | `7787c9fd` |
| 5 | Dedup InitiateCheckout: `event_id` = `sha256(offer_hash+email)` para `cart_abandonment` | `c03384b3` |
| 6 | Dedup InitiateCheckout: mesmo padrão para `WAITING` (order bumps) | `6dac7119` |
| 7 | 5 raw_events históricos cart_abandonment re-postados e processados | — |

**Sem migration nova** — dedup usa unique constraint existente em `events(workspace_id, event_id)`.

### Entregas 2026-05-11 — Dashboard de performance (esta sessão, sessão posterior)

| # | Tema | Deploy |
|---|---|---|
| 1 | `GET /v1/dashboard/stats?period=7d\|30d\|today` — 5 queries paralelas: funil+receita, dispatch health, attribution coverage, per-launch breakdown, ad spend | `11d94a7c` |
| 2 | CP dashboard home (`page.tsx`) — KpiCards Faturamento/Ticket/ROAS, FunnelCard Lead→IC→Compradores, tracking health, LaunchesTable + PeriodSelector global | — |
| 3 | `cost-backfill.ts` — `POST /v1/admin/cost-backfill?date=YYYY-MM-DD` para backfill histórico | `11d94a7c` |
| 4 | Bug fix `upsertAdSpend` — substituído `onConflictDoUpdate` (Drizzle quebrava com expression index) por `db.execute(sql\`INSERT ... ON CONFLICT (expressions) DO UPDATE\`)` + `.toISOString()` no Date | `11d94a7c` |
| 5 | Fix `resolveWorkspaceId` no cost-ingestor — lê `DEV_WORKSPACE_ID` do env em vez de hardcode | `11d94a7c` |
| 6 | Backfill Meta spend 4 dias (2026-05-08 a 11): 29 rows ingested, 0 erros Meta | — |

**Google Ads OAuth**: refresh token expirado (401) — não é bug de código, é credencial. Não bloqueia dashboard (spend Meta funciona).

**Playwright MCP**: não carrega em algumas sessões. Matar processo: `pkill -f "user-data-dir=/Users/tiagomenna/Library/Caches/ms-playwright/mcp-chrome-1ead15c"`. Se não resolver, zerar contexto.

**Edge prod**: deploy atual **`680f729c`** (IC server-side, 2026-05-12).

### Onde começar a próxima sessão

**Push pendente**: `git push origin main` — **20+ commits** locais à frente de `origin/main` (7 novos hoje). Nenhum bloqueio.

**Pendências da sessão 2026-05-13:**

1. **Bruno do Nascimento (lead OnProfit `bn56289@gmail.com`)** — comprou 12/05 22:17 BRT, webhook OnProfit nunca chegou no edge (verificado: 0 raw_events). Caso isolado. Recovery: dashboard OnProfit → reenviar webhook OU `POST` manual do JSON em `/v1/webhooks/onprofit` (token `sendflowSendtok` da workspace). Padrão Guru recovery em `memory/project_guru_api_recovery.md` cross-session.

2. **27 testes pré-existentes falhando em `tests/unit`** — confirmado pré-existente (não causado por mudanças hoje). Áreas: guru-raw-events-processor (4), raw-events-processor (1), is-test-propagation (3), workspace-config deep merge (1), launch-resolver (4), BR-WEBHOOK-003 waiting_payment (1), processor-creates-dispatch-jobs (1), T-FUNIL-012 blueprints (4), is-test events INSERT (3), flow-08 merge (5). Listar com `pnpm vitest run tests/unit 2>&1 | grep "FAIL\s"`. Não bloqueia deploy mas vale revisar.

3. **`INV-IDENTITY-008` duplicada** — uma em `docs/50-business-rules/BR-IDENTITY.md:80` (formato canônico do phone) e outra em `docs/20-domain/04-mod-identity.md:133` (denormalização). Renumerar uma sem quebrar refs.

4. **Item 2 antigo do ADR-044 §Impacta**: Backfill de pii_enc drift foi feito (16 leads). Listar como entregue.

5. **35 cart_abandonments dedup-skipados pré-ADR-045** — decisão consciente de não backfillar (risco de duplicar conversões em Meta/Google). Aceitar drift histórico. Se quiser visualizar timeline completa desses 35 leads no futuro: backfill cirúrgico via insert direto em `events` table pulando `dispatch_jobs` (opção B do diagnóstico de hoje).

**Verificar replay** (sessão anterior): confirmar que os 32 raw_events de cart_abandonment (replayed 2026-05-12) foram processados:
```sql
SELECT processing_status, COUNT(*) FROM raw_events
WHERE payload->>'_onprofit_event_type'='InitiateCheckout'
  AND payload->>'status'='CART_ABANDONED'
GROUP BY processing_status;
-- Esperado: 32 'processed' (ou mix processed+discarded para os 3 com PAID prévio)
```

**Pendências críticas restantes**: TODAS resolvidas. Nenhum P0 aberto.

**0. Aguardar 24-48h pós event_id fix** — deploy `452e3565` (2026-05-09 noite) corrigiu `event_id: event.id` → `event_id: event.eventId` nos 4 dispatchers. Validar Match Quality + Dedup Coverage Rate no Events Manager Meta para Lead/InitiateCheckout/custom events. PageView vai continuar baixo no dedup (esperado — ver `memory/project_pixel_pageview_dedup_decision.md` cross-session).

**ADR-043 NÃO escrito** — usuário pediu pra registrar como ADR, mas o write foi rejeitado e em seguida pediu pra preparar pra zerar contexto. Conteúdo da decisão preservado em memória cross-session (`project_event_id_dispatcher_fix.md` + `project_pixel_pageview_dedup_decision.md`). Próxima sessão pode promover pra ADR-043 se quiser.

**Recomendação minha pra atacar primeiro** (em ordem de valor/risco):

1. **Doc-sync pendentes** (low risk, low effort, high coverage) — 8 itens marcados `[SYNC-PENDING]` em §3 abaixo. Atualizar:
   - `CONTRACT-api-events-v1` (events.user_data jsonb shape, consent string|bool)
   - `CONTRACT-api-config-v1` (event_config.auto_page_view)
   - `BR-IDENTITY-005` (cookie `__ftk` SameSite=None Secure, sem HttpOnly)
   - `CORS público` em arch doc
   - `TEMPLATE-paid-workshop-v3-event-config-purge`
   - `CP-DOUBLE-STRINGIFY-event-config` (T-13-013)
   - `PHONE-normalizer-9-prefix-BR`
   - `ERASURE-GEO-FIELDS-AND-VISITOR-ID` (BR-PRIVACY-005 escopo expandido)

2. **Investigar 67 tests integration/e2e falhando** (médio risco, descoberto nesta sessão) — confirmados pré-existentes (rodaram em main sem minhas mudanças e falharam igual). Possíveis regressões acumuladas. Listar com `pnpm vitest run 2>&1 | grep "❯.*failed"` — começar pelos guru-launch-resolver (5 failed), processor-creates-dispatch-jobs (4 failed), flow-08-merge-leads (10 failed).

3. **MISSING-UNIT-TESTS-SESSION-2026-05-07** (low risk, hardening) — 6 specs faltando, listadas em §3. Trabalho repetitivo mas valor de regression coverage.

4. **Otimizações KV** (low priority após Workers Paid) — config cache em memory por instance, skip markSeen quando idempotency primary já marcou duplicate.

**NÃO atacar sem decisão de produto**: itens UI no Control Plane (CP-SNIPPET-GENERATOR, CP-MISSING-AUTO-PAGE-VIEW-TOGGLE).
**NÃO atacar sem dependência externa**: ONPROFIT-HMAC-VALIDATION-TODO (depende OnProfit publicar spec).

### Entregas recentes (2026-05-09) — sessão completa

| # | Tema | Commit | Deploy/Migration |
|---|---|---|---|
| 1 | Sprint 17 observability + doc-sync (anteriores) | `6af8f61` `ff92500` `0bf22f9` | `83afe16c` |
| 2 | Pacote Meta CAPI hardening (jsonb, fbc/fbp, historical lookup IP/UA/visitor_id) | `748f32e` `22db9a9` `89b1c6d` `77f97c6` `5ed259d` | `ed9a490d` `10bcaaa6` `974368b9` `ba2fbe37` |
| 3 | Health view `v_meta_capi_health` | `10277cf` | migration 0047 |
| 4 | OnProfit adapter inicial | `59003f9` `46e9c2e` | `1e905322` |
| 5 | **Migration 0048**: `obrigado-workshop.auto_page_view = false` | `a48f985` | DB only |
| 6 | **Tracker race-fix**: `capturePlatformCookies()` fresh em `track()` | `6fbcf6c` | R2 etag `991734d4` |
| 7 | CLAUDE.md §9: regra Playwright (matar processo dono) | `2974bd5` | — |
| 8 | **`markSeen` best-effort** (KV quota não 500a mais `/v1/events`) | `85777ec` | edge `f97af05f` |
| 9 | **Workers Paid ativo** ($5/mês, KV quota mensal) | (account-level) | — |
| 10 | **ADR-040** + BR-EVENT-004 refino + AGENTS rule 16 | `173dfb8` | — |
| 11 | **Migration 0049**: supersede 6 aliases órfãos `.con` (anti cross-contamination) | `3a7b6fd` | DB only |
| 12 | **Resolver supersede em re-submit** + 2 tests + BR-IDENTITY-001 update | `c89ccb4` | edge (incluso em deploys posteriores) |
| 13 | **Dispatch payload audit Meta CAPI** (request + response sanitized, IP redacted) + BR-DISPATCH-007 | `e12528b` | edge `35a93927` |
| 14 | + Captura request em GA4/Google Ads conv/enhanced + ADR-041 | `a51442b` | edge `1b2e2d74` |
| 15 | **T-14-009-FOLLOWUP**: Google Ads Conv aceita `accessToken` direto (paridade Enhanced) | `bea8042` | edge `db4c5464` |
| 16 | **OnProfit launch resolver** + lead_stages + tag_rules (paridade Guru) | `5668c67` | edge `d6ce4274` |
| 17 | **GEO-CITY-ENRICHMENT-GAP**: geo histórico Meta CAPI + view 0050 | `9a00f46` | edge `1b45681a` + migration 0050 |
| 18 | **Outbox poller + DLQ nativa** (raw_events recovery automática), ADR-042. Token CF migrado pra `.env.local`, `pnpm deploy:edge` com wrangler@4 | `fc1f778` | edge `9b78719c` + queue `gt-events-dlq` |
| 19 | **Contatos UX**: tabela com colunas sortáveis (nome, primeiro contato, lifecycle, última atividade), nova coluna `first_seen_at`, hover gray-100, datas alinhadas à direita. Edge worker aceita `sort_by`/`sort_dir` em `GET /v1/leads` | `055c45d` + `444d740` | edge `778fcbcf` |
| 20 | **Lead detail header cleanup**: removido card "Atribuição" do summary (info duplica a aba Atribuição). Helpers/imports limpos (UtmRow, utmIsEmpty, truncateClickId, GitBranch icon) | `055c45d` | — |
| 21 | **BUG FIX CRÍTICO — lead_attributions vazio para tracker leads**: `recordTouches` extraído de dentro do bloco `if (!resolvedLeadId)`. O bug: tracker dispara `lead_identify` (sem UTM) → cria lead → devolve `lead_token`. Quando o `Lead` (com UTMs) chega 250ms depois, já vem com `lead_id` no payload, então o bloco é pulado e attribution nunca grava. Fix passa a rodar para qualquer `isIdentifyEvent && resolvedLeadId && launch_id`. **Backfill: 118 lead_attributions** (36 first + 37 last + 43 all) inseridos a partir de `events.attribution`. Memória cross-session atualizada em `project_lead_attributions_fix.md` | incluído em commits acima | edge `0a331910` |
| 22 | **BUG FIX — dispatches invisíveis na timeline da UI**: `dispatch_jobs.lead_id` ficava NULL para eventos pré-identificação (PageView, clicks anônimos). Step 8 do `raw-events-processor.ts` backfillava `events.lead_id` mas não `dispatch_jobs.lead_id`. Timeline filtra por `dj.lead_id`, perdia tudo NULL. Fix estende Step 8 para UPDATE em `dispatch_jobs` via subquery por visitor_id. **Backfill: 196 dispatch_jobs** atualizados. Validado UI Ana Maria — PageView agora mostra "OK GA4 + OK Meta CAPI". Memória cross-session em `project_dispatch_jobs_lead_id_orphan.md` | `444d740` | edge `aa9dfc13` |
| 23 | **BUG FIX CRÍTICO — Meta dedup 0% (event_id PK em vez de tracker UUID)**: 4 dispatchers (Meta CAPI, GA4, Google Ads Conversion, Google Ads Enhanced) enviavam `event_id: event.id` (PK do Postgres) em vez de `event_id: event.eventId` (UUID do tracker exposto em `window.__funil_event_id`). Browser Pixel passa o tracker UUID via `{eventID}`, CAPI passava o PK do banco → nunca batiam → Meta nunca dedupava. Confirmado via DB: dos últimos 7 dias, 472 PageView, 41 click_buy, 31 Lead, 6 Purchase com bug. Pós-fix: 4 ocorrências em `apps/edge/src/index.ts` (linhas ~1270/1564/1756/1930). **Investigação adicional via Playwright**: boilerplate Pixel da LP dispara `fbq('track', 'PageView')` SEM eventID antes do tracker carregar — esse PageView (sem eventID) é o que vai pra rede; o segundo PageView do snippet GT (com eventID) é deduplicado internamente pelo Pixel e descartado. **Decisão: NÃO remover boilerplate** — o `fbq('track','PageView')` síncrono cria cookie `_fbp` que tracker captura. Removê-lo quebraria match quality em TODOS os eventos da sessão. PageView fica sem dedup (custo aceito). Detalhes em `project_pixel_pageview_dedup_decision.md` (cross-session). | `9b75337` | edge `452e3565` |
| 24 | **BUG FIX CRÍTICO — 3/67 leads sem evento `Lead`**: investigação iniciada por Sheila Richeti (`8edc5512`) com timeline inconsistente. Padrão: leads tinham apenas `lead_identify` (vindo de `/v1/lead`), sem `Lead` event do tracker → sem `lead_workshop` stage (blueprint mapeia stage a `source_events: ["Lead"]`, e `lead_identify` está em `INTERNAL_ONLY_EVENT_NAMES`), sem dispatch_jobs (Meta CAPI não notificada), sem attribution touchpoints. Dois bugs em `apps/tracker/snippets/paid-workshop/workshop.html` `wireForm()`: (1) `attribution: {}` hardcoded no body do POST `/v1/lead` (`readUtms()` existia mas só era usada na URL Guru); (2) `setTimeout(redirectToCheckout, 120)` ficava no `.then()` final fora do `withTracker` callback — submits antes do tracker.js executar disparavam o redirect em 120ms cancelando o polling de `withTracker` → `F.track('Lead')` nunca rodava. Fix: `attribution: readUtms()` + redirect movido para dentro do `withTracker` com fallback de 2s + flag `redirected` anti-duplo navigation. **Validação E2E via Playwright** contra LP de prod (`/wk-societarios-1/?utm_source=teste-fix&fbclid=TEST_FBCLID_QA`): 5 requests na ordem correta — config → PageView → click_buy → `/v1/lead` (com UTMs+fbclid) → `Lead` event (visitor_id preenchido + UTMs + fbc/fbp/_ga/_gcl_au). Snippet em produção atualizado pelo usuário no WPCode. **NÃO requer redeploy edge nem migration** — só snippet e doc. BR-TRACKER-002 documentada em `docs/20-domain/13-mod-tracker.md` §8. **RECOVERY EXECUTADO 2026-05-10**: 3 leads (Sheila `8edc5512`, Maria Fernanda `0cecf516`, Flávio `b238a9af`) recuperados — Lead event inserido (`event_source='admin'`), `lead_workshop` stage criado, dispatch Meta CAPI executado (3/3 `succeeded`). Runbook em `docs/60-flows/11-manual-dispatch-recovery.md`. | `5b32b5b` + doc-sync + recovery | — |

### Replays executados (2026-05-09 ~07:00–07:11 UTC)

7 dispatch_jobs de Meta CAPI (Purchase events com `utm_source=meta`) replayados via `POST /v1/dispatch-jobs/:id/replay` após deploy `ba2fbe37`. Todos succeeded. Match score subiu de 4-5/8 (original) para **7/8** (após enrichment com fbc/fbp/IP/UA/visitor_id históricos do mesmo lead). Falta apenas `geo_city` (não vem dos contact.address de algumas Guru transactions).

### Observabilidade — health check ad-hoc

```sql
SELECT received_at, match_score, eff_fbc, eff_fbp, eff_ip, eff_ua,
       eff_external_id, lead_em, lead_ph, amount, product_name, utm_source
  FROM v_meta_capi_health
 WHERE event_name='Purchase' AND received_at > now()-interval '24 hours'
 ORDER BY received_at DESC;
```

A view tem semântica "sem filtro temporal" — reflete o que o dispatcher REAL faz (lookup pega os 10 mais recentes do lead, mesmo posteriores ao evento, alinhado com `apps/edge/src/index.ts:lookupHistoricalBrowserSignals`).

### OnProfit configuração (IMPORTANTE)

- **Webhook URL**: `https://globaltracker-edge.globaltracker.workers.dev/v1/webhooks/onprofit?workspace=outsiders`
- **ERRO RESOLVIDO**: slug era `outsiders`, não `outsiders-digital`. Testado com 202 ✓
- **Checkout page criada**: `checkout-onprofit-workshop` (role=checkout, launch=wkshop-cs-jun26)
- **Tracker.js snippet**: instalado no HTML slot do checkout OnProfit (data-launch-public-id=`wkshop-cs-jun26`)
- **Pixel Web OnProfit**: OFF (usuário decidiu desativar para evitar conflito)
- **HMAC validation**: TODO — OnProfit não publicou spec do header ainda; protegido só por slug

### Sprint 16 — ondas entregues (detalhes em `git show <commit>`)

| Onda | Tema | Commit(s) | Deploy edge |
|---:|---|---|---|
| 1 | Meta CAPI external_id + IP/UA | `19bd917` (+ hotfix `1f95781`) | `e9a0a989` → `29f63e20` |
| 2 | GA4 client_id cascade + dispatch-replay fix (ADR-032, OQ-012 fechada) | `4bde77f` + `4dd703d` + `4eff5f9` | sucessivos |
| 3 | Geo enrichment Cloudflare + Guru contact.address (ADR-033) | (incluso em commits seguintes) | — |
| 4 | SendFlow pipeline fix (queue ingestion ponta-a-ponta) | `052d3b3` + `33549b9` + `f0d86dc` | `a64d6825` |
| 5 | Leads UX Fase 1 (3 colunas + multi-search + GMT-3) | `b143a0c` | — |
| 6 | Leads RBAC Fase 2 (JWT verify + masking + reveal, ADR-034) | `c183411` | `9224056b` |
| 7 | Lead Lifecycle + Products Catalog | `cf66e83` | `ed818549` |
| 8 | Launch Products + UI revamp + cadastro manual | `0fb5ca6` `2c04c97` `542c5e0` `0d6a0ed` | `68a7fcff` → `242869d2` |
| 9 | Recovery de Vendas (Guru abandoned/refund/chargeback) | `938a01f` | `f798d162` |
| 10 | Contatos vs Leads + lead_tags + tag_rules | `72ce0ee` | `bc11afa8` → `e818d984` |
| 11 | PII enrichment via Guru + last_seen_at monotônico | `1279304` | `d6ff7b4a` |
| 12 | lead-payload consent string\|bool + visitor_id arch | `ed14fd5` + `854ecd5` | `83afe16c` |

Doc-sync das Ondas 9–12 foi entregue no commit `445c048`.

---

## §2 Estado dos sprints

| Sprint | Status | Fonte canônica |
|---|---|---|
| 0 | completed | [`00-sprint-0-foundations.md`](docs/80-roadmap/00-sprint-0-foundations.md) |
| 1 | completed | [`01-sprint-1-fundacao-dados-contratos.md`](docs/80-roadmap/01-sprint-1-fundacao-dados-contratos.md) |
| 2 | completed | [`02-sprint-2-runtime-tracking.md`](docs/80-roadmap/02-sprint-2-runtime-tracking.md) |
| 3 | completed | [`03-sprint-3-meta-capi-webhooks.md`](docs/80-roadmap/03-sprint-3-meta-capi-webhooks.md) |
| 4 | completed (`c1e4abc`) | [`04-sprint-4-analytics-google.md`](docs/80-roadmap/04-sprint-4-analytics-google.md) |
| 5 | completed (`3757690`) | [`05-sprint-5-audience-multitouch.md`](docs/80-roadmap/05-sprint-5-audience-multitouch.md) |
| 6 | completed (`e613140`) | [`06-sprint-6-control-plane.md`](docs/80-roadmap/06-sprint-6-control-plane.md) |
| 7 | completed (`bd44b7f`) | [`07-sprint-7-orchestrator.md`](docs/80-roadmap/07-sprint-7-orchestrator.md) |
| 8 | completed (`4c72732`) | [`08-sprint-8-ai-dashboard.md`](docs/80-roadmap/08-sprint-8-ai-dashboard.md) |
| 9 | completed (`ded8fd2`) | [`09-sprint-9-funil-ux-hardening.md`](docs/80-roadmap/09-sprint-9-funil-ux-hardening.md) |
| 10 | completed (`ac93148`) | [`10-sprint-10-funil-templates-scaffolding.md`](docs/80-roadmap/10-sprint-10-funil-templates-scaffolding.md) |
| 11 | completed (`165855c`) | [`11-sprint-11-funil-webhook-guru.md`](docs/80-roadmap/11-sprint-11-funil-webhook-guru.md) |
| 12 | in progress (Onda 3 parcial — passos 1–4 do E2E) | [`12-sprint-12-funil-paid-workshop-realinhamento.md`](docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md) |
| 13 | planned (foundation funil B + cleanups) | [`13-sprint-13-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/13-sprint-13-webhooks-hotmart-kiwify-stripe.md) |
| 14 | completed (`f19b488`; T-14-017 adiado — ver §4) | [`14-sprint-14-fanout-google-ads-ga4.md`](docs/80-roadmap/14-sprint-14-fanout-google-ads-ga4.md) |
| 15 | planned (webhook adapters Hotmart/Kiwify/Stripe) | [`15-sprint-15-webhooks-hotmart-kiwify-stripe.md`](docs/80-roadmap/15-sprint-15-webhooks-hotmart-kiwify-stripe.md) |
| 16 | completed (Ondas 1–12 entregues 2026-05-08) | a criar |
| 17 | completed (`6af8f61`; doc-sync 2026-05-09) | a criar |

---

## §3 Pendências abertas

### Otimizações de KV writes (TECH-DEBT, médio prazo)

Hoje cada `/v1/events` faz ~3 KV writes (rate-limit + idempotency + markSeen) e cada `/v1/config` faz ~2 (rate-limit + cache). Workers Paid resolve o teto, mas reduzir writes melhora custo+performance e diminui acoplamento ao KV. Itens (não bloqueantes — só compensam se volume crescer >10x):

- **Config cache em memória por instance** — hoje cada cold start re-busca config do DB e regrava no KV. In-memory Map com TTL mediano cobriria boa parte sem write.
- **Rate-limit em Durable Objects** — sliding window via DO state em vez de KV counter. Menos writes, mais preciso, atomicidade nativa.
- **Skip markSeen quando idempotency já marcou duplicata** — hoje sempre tenta gravar; pode ler antes ou unificar com idempotency.checkAndSet.
- **TTL maior em config cache** — se config muda raramente, TTL atual pode estar alto demais (gerando refresh writes).

Tracking: criar issue futura quando o assunto voltar.

### Pendências críticas — Meta CAPI EMQ Hardening (2026-05-09)

- ~~**PIXEL-SNIPPET-LP-FIX (USUÁRIO)**~~ — RESOLVIDO 2026-05-09 (diagnóstico anterior estava errado). HTML deployado em `wk-obg` JÁ tem `fbq('consent','grant')` + `fbq('init','149334790553204')` + `fbq('track','PageView')` síncronos no head. O bug real era race interno do tracker (state.platformCookies snapshot em init vs handler do snippet executando durante `await fetchConfig` do init). Resolvido pelo tracker race-fix entregue nesta sessão. Validado via Playwright contra LP de prod.
- ~~**DISPATCH-ATTEMPTS-PAYLOAD-EMPTY**~~ — RESOLVIDO 2026-05-09 (deploy edge `35a93927`). `DispatchResult` extendido com `request?`/`response?` opcionais. Helper `sanitizeDispatchPayload` em `apps/edge/src/lib/dispatch-payload-sanitize.ts` redacta `client_ip_address`/`ip` (LGPD). `processDispatchJob` aplica como última camada (defesa em profundidade) e grava nas 6 call sites em vez de `{}` literal. Validado em prod com Lead event de teste — request mostra hashes em/ph/fn/ln/ct/st/zp/country preservados, IP redacted, response da Meta `{events_received, fbtrace_id, messages}` capturada. **Implementado apenas em Meta CAPI nesta entrega**; GA4/Google Ads/audience-sync continuam gravando `{}` (incremental — BR-DISPATCH-007 documenta tabela de status). Doc-sync: BR-DISPATCH-007 nova.
- ~~**GEO-CITY-ENRICHMENT-GAP**~~ — RESOLVIDO 2026-05-09 (deploy `1b45681a` + migration 0050). `lookupHistoricalBrowserSignals` agora retorna geo_city/geo_region_code/geo_postal_code/geo_country também. `buildMetaCapiDispatchFn` faz fallback via histórico do tracker.js quando o evento corrente não traz geo (caso típico: Purchase Guru sem contact.address). View `v_meta_capi_health` atualizada com `eff_geo` (CTE historical + match_score considerando hist_geo_city). Validação: 27 Purchases com `eff_geo=true`, antes 4 ficavam em score 7 — agora 15 em 8.
- **JSONB-LEGACY-ROWS-BACKFILL** — Rows pré-deploy `ed9a490d` (todas events/raw_events/dispatch_jobs anteriores a 2026-05-09 ~05:00) têm `jsonb_typeof='string'` em colunas jsonb. Funciona via Drizzle (parse na leitura), mas queries SQL ad-hoc precisam de `(col #>> '{}')::jsonb` defensivo. Backfill seria UPDATE em massa para re-cast: `UPDATE events SET user_data = (user_data #>> '{}')::jsonb WHERE jsonb_typeof(user_data)='string'`. Não urgente — mitigado via `lookupHistoricalBrowserSignals` defensivo e view `v_meta_capi_health`.

### Bloqueios e TODOs de código

- **GOOGLE-ADS-OAUTH-REFRESH-401** — Cron de cost ingestor reporta `google_ads_fetch_failed: OAuth token exchange failed with HTTP 401` em todas as datas. Refresh token expirado. Resultado: investimento Google Ads = R$ 0 no dashboard. Não bloqueia Meta. Fix: reconectar OAuth no CP (Settings → Integrations → Google Ads).
- ~~**SENDFLOW-WEBHOOK-PAUSED-NO-RETURN**~~ — Resolvido 2026-05-15: (a) 41 events do gap recuperados via mirror N8N (workflow `ExuNm1Nm64Xud0uX` em `mennaworks.app.n8n.cloud`) usando script novo `scripts/maintenance/sendflow_n8n_replay.mjs` — dedup por conteúdo `truncSec(data.createdAt)+number+groupId` (SendFlow regera `body.id` por delivery, não serve cross-source); (b) user reativou webhook no painel SendFlow. Padrão de recovery via N8N documentado em [`docs/60-flows/11-manual-dispatch-recovery.md`](docs/60-flows/11-manual-dispatch-recovery.md) Parte D.

- **MISSING-UNIT-TESTS-SESSION-2026-05-07** — TODO Sprint 16. 6 specs faltando:
  1. `tests/unit/dispatchers/meta-capi/mapper.test.ts` — mapeamento de custom events (`custom:click_wpp_join` → `Contact`, `custom:watched_workshop` → `ViewContent`). **Nota**: `click_buy_*` removidos do mapper em 2026-05-12 (commit `1700514`) — não testar mais mapeamento deles para IC.
  2. `tests/unit/dispatchers/ga4-mp/mapper.test.ts` — `begin_checkout`, `join_group`, `view_item` + `params.group_id` extraído de `cd.group_id` ou `cd.campaign_id`.
  3. `tests/unit/dispatchers/ga4-mp/client-id-resolver.test.ts` — `extractClientIdFromGaCookie` parse de `GA1.1.<n>.<n>`.
  4. `tests/unit/lib/raw-events-processor.test.ts` — `UserDataSchema` aceita `_ga`/`fvid` nullish e rejeita keys desconhecidas (`.strict`).
  5. `tests/integration/edge/config-route.test.ts` — `/v1/config` retorna config real do DB quando HYPERDRIVE/DATABASE_URL bindings presentes.
  6. `tests/unit/edge/ga4-sibling-lookup.test.ts` — Purchase sem `_ga` busca em events anteriores do mesmo lead.
  7. (a partir da Onda 3) `buildMetaCapiDispatchFn` hashing geo + Google mapper addressInfo geo.

- **CP-SNIPPET-GENERATOR-INCOMPLETE** — TODO Sprint 16. Gerador em [`apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/[page_public_id]/page-detail-client.tsx`](apps/control-plane/src/app/(app)/launches/[launch_public_id]/pages/[page_public_id]/page-detail-client.tsx) desalinhado com `apps/tracker/snippets/paid-workshop/*.html`:
  - `buildHeadSnippet` (L81): só emite tracker.js, **sem GA4/Meta Pixel** nem instruções WP Rocket.
  - `buildBodySnippet` (L97): usa `Funil.identify({email, phone, name})` — viola INV-TRACKER-008/BR-TRACKER-001 (API só aceita `lead_token`).
  - `buildDetectionScript` (L131): `consent.{analytics,marketing}: false` — deveria ser `'granted'` em todas finalidades.
  - **Plano**: (1) `buildHeadSnippet` v2 emite GA4 → Pixel → tracker (skip blocos não configurados), comentário com exclusões WP Rocket; (2) substituir `buildBodySnippet` por `buildFooterSnippet(role)` específico por `pages.role` (sales/thankyou/webinar); (3) corrigir consent + adicionar `fbq` calls com `eventID`; (4) tests cobrindo head sem GA4, head sem Meta, snippet por role.

- **CP-MISSING-AUTO-PAGE-VIEW-TOGGLE** — Tela de Configuração de eventos da page no CP não expõe toggle `auto_page_view` que vive em `pages.event_config.auto_page_view`. Hoje só via SQL direto. Política canônica (migration 0039): `role=thankyou → false`, `role=sales/webinar → true`. `obrigado-workshop` corrigido para `false` via migration 0048 (2026-05-09) após edição manual incorreta.

- **ONPROFIT-HMAC-VALIDATION-TODO** — `apps/edge/src/routes/webhooks/onprofit.ts:96-100` loga warn `onprofit_webhook_hmac_validation_todo` em todo request porque o spec do header HMAC do OnProfit não foi publicado. Hoje protegido apenas por `?workspace=<slug>` no query string. Atualizar quando OnProfit publicar a assinatura.

- ~~**ONPROFIT-LAUNCH-RESOLVER-TODO**~~ — RESOLVIDO 2026-05-09 (deploy `d6ce4274`). Criado `apps/edge/src/lib/onprofit-launch-resolver.ts` (mirror estrutural de `guru-launch-resolver.ts` — Strategy 0 launch_products, Strategy 1 product_launch_map legacy, Strategy 2 last_attribution, Strategy 3 none). Wired na rota `/v1/webhooks/onprofit` (resolve antes do raw_event insert; falha não-fatal). Processor agora ler `payload.launch_id`/`funnel_role` injetados, popula `events.launchId`, e implementa Steps 9+10 (lead_stages + tag_rules) seguindo blueprint do funnel. Próximo Purchase OnProfit emite stage corretamente.

- **T-13-013-FOLLOWUP** — RESOLVIDO (commit `22db9a9`, deploy `ed9a490d`, 2026-05-09). Helper `jsonb()` aplicado em ~58 writes em 12 arquivos do edge worker (4 raw-events-processors + dispatch.ts + index.ts + 6 webhook adapters). Adicionado `tests/helpers/jsonb-unwrap.ts` para mocks de teste extraírem JS value do SQL fragment. Pendente: backfill de rows antigas (events.user_data/custom_data/attribution/consent_snapshot ainda com jsonb_typeof='string' nas linhas pré-deploy — não bloqueia, queries SQL ad-hoc precisam usar `(col #>> '{}')::jsonb` pra essas).

- ~~**T-14-009-FOLLOWUP**~~ — RESOLVIDO 2026-05-09 (deploy `db4c5464`). `GoogleAdsConfig` aceita `accessToken?` direto; `buildGoogleAdsConversionDispatchFn` agora usa `getGoogleAdsAccessToken` (mesmo helper do Enhanced) — paridade entre os dois dispatchers Google Ads. `invalid_grant` agora classifica como `oauth_token_revoked` (skip permanente actionable) em vez de `server_error` (retry inútil). Backward-compat preservado: client ainda aceita `oauth?` legacy. 3 testes novos (50 total).

### Doc-sync pendentes (`SYNC-PENDING`)

- **ERASURE-GEO-FIELDS-AND-VISITOR-ID** (Sprint 16, ADR-033 + Sprint 17 hardening, ADR-039) — `apps/edge/src/lib/erasure.ts` (`eraseLead`) precisa zerar em **TODOS** os events do lead (não apenas no atual): `events.user_data.{geo_city, geo_region_code, geo_postal_code, geo_country, fbc, fbp, client_ip_address, client_user_agent}` + `events.visitor_id` (coluna dedicada, ADR-031). Geo via IP é dado pessoal sob LGPD. `visitor_id` é propagado via `lookupHistoricalBrowserSignals` (ADR-039) e precisa ser anonimizado para impedir re-enrichment em replays pós-erasure. Doc atualizada 2026-05-09 em `docs/50-business-rules/BR-PRIVACY.md` BR-PRIVACY-005 com escopo expandido (ainda marcada `[SYNC-PENDING]` até código mudar). ETA: próxima sprint que toque erasure.
- **CONTRACT-api-events-v1** — `event-payload.ts` aceita `user_data`, `attribution.nullish()`, consent string-or-bool. Atualizar `docs/30-contracts/05-api-server-actions.md`.
- **CONTRACT-api-config-v1** — Response inclui `event_config.auto_page_view`. Atualizar doc.
- **BR-IDENTITY-005** — Cookie `__ftk` mudou de `HttpOnly; SameSite=Lax` para `SameSite=None; Secure` sem HttpOnly (tracker lê via JS para propagar identidade cross-page). Atualizar BR + ADR.
- **CORS público** — Quando `pages.allowed_domains` está vazio, libera todas as origens (security via page token). Atualizar `docs/10-architecture/06-auth-rbac-audit.md`.
- **TEMPLATE-paid-workshop-v3-event-config-purge** — Migration 0034 manteve `Purchase` e `Contact` em `event_config.canonical` da page `obrigado-workshop`, mas pela arquitetura v3 ambos são server-side (Purchase via webhook Guru, Contact via webhook SendFlow). Próxima migration deve deixar canonical=`[PageView]`, custom=`[click_wpp_join, survey_responded]`. Aplicado runtime em `wkshop-cs-jun26` via UI do CP; template global ainda divergente. Verificar se o mesmo cabe em outras pages.
- **CP-DOUBLE-STRINGIFY-event-config** (T-13-013) — Save handler do CP grava `event_config` como string JSON dentro do JSONB (double-encoded). UPDATE manual já aplicado em `wkshop-cs-jun26`. Encontrar e corrigir o save handler que está rodando `JSON.stringify` antes do Drizzle.
- **PHONE-normalizer-9-prefix-BR** — `normalizePhone` em `apps/edge/src/lib/lead-resolver.ts:67` não reconcilia mobiles BR sem o "9" extra. Sistemas legados (SendFlow) enviam phone sem o 9 → `phone_hash` divergente. Tracking T-13-014. Após implementação atualizar `BR-IDENTITY-002` + nova `INV-IDENTITY-008` (mobile canônico = 13 dígitos `+55DD9XXXXXXXX`).
- ~~**RAW_EVENTS-jsonb-string**~~ — RESOLVIDO via T-13-013-FOLLOWUP (commit `22db9a9`, deploy `ed9a490d`, 2026-05-09). Helper `jsonb()` agora aplicado em todos call sites do edge. Doc-sync 2026-05-09: padrão documentado em `docs/30-contracts/02-db-schema-conventions.md` + ADR-038 + `BR-EVENT-005` reforçada. Pendência residual: backfill em massa de rows pré-deploy `ed9a490d` (jsonb-string legadas) — não urgente, mitigado via parse defensivo em reads. Tracking em `JSONB-LEGACY-ROWS-BACKFILL` acima.

### Pendências residuais — Sprint 16 Onda 8 (Products)

- **T-PRODUCTS-009**: integration tests E2E (`guru-purchase-promotes-lifecycle`, `lead-lifecycle-progression`).
- **T-PRODUCTS-010**: tela `/leads/[id]` seção "Compras" listando produtos comprados (deferred Onda 7).
- **T-PRODUCTS-011**: depreciar `product_launch_map` legacy — após confirmar resolver Strategy 0 estável, remover Strategy 1 fallback + UI legacy.
- **T-PRODUCTS-012** (FUTURE-002): tornar mapping categoria→lifecycle editável via tabela `lifecycle_rules(workspace_id, category, lifecycle_status)`. Função `lifecycleForCategory(workspaceId, cat)` já recebe `workspaceId` para facilitar migração sem rewrite.

### Trilhas E2E em aberto

#### TRILHA 1 — Purchase real via Guru (cartão real)

Comprar workshop em `https://clkdmg.site/pay/wk-contratos-societarios`. Valida pipeline completo: form workshop → `/v1/lead` → enrich PII → redirect Guru com UTMs → checkout → cartão → webhook Guru → `purchased_workshop` stage.

**Pré-requisitos**: tracker.js em prod com fix de race; snippet workshop com `stopImmediatePropagation`. **CRÍTICO** — abrir page com UTMs explícitas (ex: `?utm_source=teste-trilhaA&utm_campaign=cartao-real-2026-05`) para destravar T-13-009.

**O que validar pós-compra**:
1. `events` row `event_name='Purchase'`, `event_source='webhook:guru'`, `customData.dates.confirmed_at` populado, `customData.amount` correto, `attribution.utm_*` populados (fecha T-13-009 se UTMs chegaram).
2. `lead_stages` row `stage='purchased_workshop'`, `funnel_role='workshop'`.
3. `leads.email_enc/phone_enc/name_enc` populados via `enrichLeadPii` (já wired em guru-raw-events-processor desde Onda 11).
4. Se 2 webhooks (autorização + settlement), confirmar UPDATE com `dates.confirmed_at` correto via T-13-010 fix (`guru_webhook_updated_with_newer_payload` no log).

```sql
SELECT id, event_name, event_source, lead_id, event_time, attribution, custom_data
  FROM events
 WHERE workspace_id='74860330-a528-4951-bf49-90f0b5c72521'
   AND event_name='Purchase' AND received_at > now() - interval '15 minutes'
 ORDER BY received_at DESC LIMIT 5;
```

**Cuidado**: compra real tem custo. Combinar com Tiago (cartão pessoal vs sandbox Guru). Após teste, registrar lead resultante + event_ids para regressão.

#### TRILHA 3 — T-13-012 Survey form em obrigado-workshop

Formulário de pesquisa pós-compra do workshop, dispara `custom:survey_responded` → stage `survey_responded`. Audience `respondeu_pesquisa_sem_comprar_main` já existe no template v3 (migration 0036).

**Onde**: page `/wk-obg/` no WordPress (Elementor atomic form), CSS ID `gt-form-survey`. Snippet WPCode FOOTER intercepta submit em capture phase com `ev.preventDefault() + ev.stopImmediatePropagation()`, monta `customData` com respostas, chama `Funil.track('custom:survey_responded', { custom_data: { q1, q2, q3 } })`. BR-EVENT-001 exige prefixo `custom:`. Schema validado contra `pages.event_config.custom_data_schema` (hoje `{}`).

**Conteúdo das perguntas**: confirmar com Tiago no início da trilha (decisão de produto).

**Reaproveitar**: `apps/tracker/snippets/paid-workshop/workshop.html:128-194` (wireForm) como modelo.

**Validação**:
1. Aplicar form na page WP, allowlist Wordfence, limpar WP Rocket.
2. Modo anônimo: visitar `/wk-obg/`, preencher, submeter.
3. SQL: novo `events` row `event_name='custom:survey_responded'` + `lead_stages` `stage='survey_responded'`.
4. Audience: lead deve aparecer em `respondeu_pesquisa_sem_comprar_main` se ainda não comprou main.

---

## §4 Tarefas futuras

### PIXEL-EXTERNAL-ID — Passar `external_id` no Pixel browser para aumentar match rate Lead (+8.57%)

Hoje o CAPI envia `external_id = visitor_id` (cookie `__fvid`, UUID v4) em 83.6% dos Lead events. O Pixel browser não envia `external_id`. Meta mostra como "Outros parâmetros" porque quer ambas as fontes sincronizadas — isso desbloquearia +8.57% mediano em conversões adicionais relatadas para o evento Lead.

**Implementação**: no snippet HEAD da page `workshop`, após o fbq init, ler `__fvid` do cookie e passar via `fbq('init', PIXEL_ID, { external_id: fvid })`. Só funciona para visitantes com cookie de sessão anterior (cold starts ficam sem). Ajuste mínimo no snippet; sem mudança no edge.

**Prioridade**: baixa. Não bloqueia nenhuma sprint.

---

### T-14-017 — Backfill Google Ads (90 dias de Purchase)

Script que cria retroativamente `dispatch_jobs` para `google_ads_conversion` + `google_enhancement` para Purchase events anteriores à conexão Google Ads.

**Pré-requisitos**: OAuth Google Ads conectado no workspace + `conversion_actions` mapeados em `workspaces.config.integrations.google_ads.conversion_actions`. Setup externo (criar OAuth Client no Google Cloud Console, solicitar developer_token Basic access ~1–2 dias úteis, `wrangler secret put` de `GOOGLE_OAUTH_CLIENT_ID/SECRET/STATE_SECRET` + `GOOGLE_ADS_DEVELOPER_TOKEN`, adicionar `GOOGLE_OAUTH_REDIRECT_URI` em `wrangler.toml`).

**Como**: rodar `/tmp/pgquery/test-fanout-google.mjs` para sanidade, depois script análogo a `replay-ga4-purchase-skips-v2.mjs` — Purchase events últimos 90d sem `dispatch_jobs` para `google_ads_conversion` → INSERT.

**Limite API**: conversions >90d são rejeitadas. Estimativa ~30min após pré-requisitos.

---

## §5 Ambiente operacional

| Item | Valor |
|---|---|
| Repo | `https://github.com/sudomenna/globaltracker` (privado) |
| Branch | `main` |
| Supabase project | `kaxcmhfaqrxwnpftkslj` (globaltracker, sa-east-1, org CNE Ltda) |
| Workspace slug | `outsiders` (ID `74860330-a528-4951-bf49-90f0b5c72521`) — usar em `?workspace=outsiders` |
| Cloudflare account | `118836e4d3020f5666b2b8e5ddfdb222` (cursonovaeconomia@gmail.com) |
| CF KV (prod) | `c92aa85488a44de6bdb5c68597881958` |
| CF KV (preview) | `59d0cf1570ca499eb4597fc5218504c2` |
| CF Queues | `gt-events`, `gt-dispatch` |
| Hyperdrive | config `globaltracker-db`, id **`34681cabdb954437ba6db304a235da87`** (Supavisor pooler `aws-1-sa-east-1.pooler.supabase.com:5432`, session mode) |
| Worker prod | `globaltracker-edge.globaltracker.workers.dev` |
| R2 bucket | `gt-tracker-cdn` (público em `pub-e224c543d78644699af01a135279a5e2.r2.dev`) |
| Wrangler | **`pnpm deploy:edge`** (wrangler@4; bug CF-10023 resolvido pela CF em 2026-05-09). Token em `.env.local` como `CLOUDFLARE_API_TOKEN` (gitignored). API token "Edit Cloudflare Workers" — **não** OAuth de `wrangler login`. |
| Supabase CLI | 2.90.0 |
| Node | 24.x (v24.10.0) |
| pnpm | 10.x |

**DB connect ad-hoc**: `host=db.kaxcmhfaqrxwnpftkslj.supabase.co port=5432 user=postgres database=postgres ssl={rejectUnauthorized:false}` — senha em `~/.zshrc` ou cofre.

**Recovery operacional pós-deploy**: rodando via Hyperdrive desde 2026-05-13. `DATABASE_URL` secret continua válido como fallback puro (mas não captura exceção em runtime — rollback necessário se Hyperdrive der incident).

---

## §6 Notas técnicas invariantes

- **DB binding pattern**: `HYPERDRIVE?.connectionString ?? DATABASE_URL ?? ''` — **Hyperdrive primeiro, DATABASE_URL é fallback puro**. ADR-046. Não inverter a ordem em hipótese alguma; `DATABASE_URL` secret pode estar divergente do Hyperdrive binding (host direto, senha velha) e quebrar silenciosamente em rotas que o usam primeiro. Tarefa futura: extrair helper `getDbConnStr(env)` em `apps/edge/src/lib/db-conn.ts` e refactorar os ~46 callsites.
- **Smoke test pós-mudança de credencial DB / Hyperdrive**: rodar `bash scripts/maintenance/webhook-smoke-test.sh` (INV-INFRA-001, ADR-046) **após**: rotação de senha Supabase, reconfiguração Hyperdrive (novo ID ou conn string), `wrangler secret put DATABASE_URL`, codemod que toque DB conn, deploy de rota webhook nova. Saída esperada: todos endpoints 4xx (validation failure é OK). 5xx = DB conn quebrada. Script rodou verde em 2026-05-13 pós-fix do incidente original (deploy `b3dd4cc2`).
- **Migrations**: duas pastas — `packages/db/migrations/0NNN_*.sql` e `supabase/migrations/20260502000NNN_*.sql`. Manter sincronizadas.
- **RLS dual-mode**: `NULLIF(current_setting('app.current_workspace_id', true), '')::uuid OR public.auth_workspace_id()`.
- **JSONB writes**: usar helper `jsonb()` em [`apps/edge/src/lib/jsonb-cast.ts`](apps/edge/src/lib/jsonb-cast.ts) (dollar-quoted via `sql.raw`) para qualquer escrita em coluna jsonb. Driver pg-cloudflare-workers/Hyperdrive serializa params como text com aspas — sem o helper, valores JSON viram jsonb-string.
- **JSONB reads**: parse defensivo `(payload #>> '{}')::jsonb` ou JSON.parse — pode chegar como string em rows legadas.
- **Cookie `__ftk`**: `SameSite=None; Secure;` sem `HttpOnly` (tracker lê via JS). BR-IDENTITY-005 sync pendente.
- **Tracker.js**: `dist/` é gitignored. Após mudar `apps/tracker/src/`: `node build.config.js` + `npx wrangler r2 object put gt-tracker-cdn/tracker.js --remote --file=./dist/tracker.js --content-type=application/javascript`.
- **Edge redeploy**: `cd apps/edge && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler@2.20.0 publish` (NÃO `deploy`, NÃO da raiz do monorepo).
- **Tracker dedup**: events deduped por `(event_name, sessionStorage)` TTL 5min. Segundo Lead/PageView na mesma sessão → `event_duplicate_accepted` (esperado).
- **`/v1/events`**: dual-mode — POST = tracker.js (public auth+CORS), GET = CP (admin CORS, Bearer auth).
- **Events partitioned**: tabela `events` é `PARTITIONED BY RANGE (received_at)` — UNIQUE constraint inclui `received_at`. `INSERT ... ON CONFLICT` não dispara para retries em horários diferentes; usar pre-insert SELECT por `(workspace_id, event_id)` (padrão T-FUNIL-047 / T-13-008).
- **CP**: usar `<dialog open>` nativo (não `div role="dialog"`).
- **OXC parse error** em type aliases multi-linha → usar `Record<string, unknown>`.
- **Biome**: varre `.claude/worktrees/`. Limpar com `git worktree remove -f <path>` após uso.
- **Semântica `null=tombstone`** (ADR-027): `null` em qualquer chave do body do `PATCH /v1/workspace/config` (qualquer profundidade) **deleta** a chave do JSONB. Padrão genérico para PATCHes futuros sobre configs JSONB.
- **Routes mounting order**: rotas mais específicas (ex: `/v1/launches/:id/products`) **antes** de `launchesRoute` em `apps/edge/src/index.ts` — caso contrário o catch-all intercepta primeiro.
- **`hashPii` é workspace-scoped** (uso interno lead-resolver); para Meta/Google usar `hashPiiExternal` (SHA-256 puro) + colunas `email_hash_external/phone_hash_external/fn_hash/ln_hash` na tabela `leads`.

---

## §7 Política de uso

- `MEMORY.md` é volátil — pode ser limpa entre sessões.
- Decisões importantes migram para [`docs/90-meta/04-decision-log.md`](docs/90-meta/04-decision-log.md) (ADR).
- OQs migram para [`docs/90-meta/03-open-questions-log.md`](docs/90-meta/03-open-questions-log.md).
- Não duplique aqui o que já está em ADR/OQ — referencie.
- Histórico de ondas/sprints fica em `git log` + `docs/80-roadmap/<sprint>.md`. Não copiar pra cá.
- Bugs RESOLVIDOS saem do MEMORY após o commit que os fechou. Se foi resolvido, `git show <commit>` é a fonte.
