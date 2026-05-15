# FX Rates Provider

## Papel no sistema
Buscar taxa cambial diária para normalização de `ad_spend_daily.spend_cents_normalized`.

## Status

**Fase 3** — junto com cost ingestor.

## Estratégia: provedor configurável (OQ-001)

`FX_RATES_PROVIDER` ∈ `{ecb, wise, manual}`.

| Provider | Características | Uso recomendado |
|---|---|---|
| `ecb` | European Central Bank — gratuito, oficial, atualização diária ~16:00 CET | Default; reliable; cobertura 30+ moedas |
| `wise` | Wise (TransferWise) API — pago, taxa real de mercado | Quando precisão financeira importa |
| `manual` | Operador insere taxas via Control Plane (Fase 4) | Casos especiais ou fallback offline |

## Endpoints (out)

### ECB

```
GET https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
```

Retorna XML com taxas EUR-base. Sistema converte para par desejado (BRL/USD/etc.) via cross-rate.

### Wise

```
GET https://api.wise.com/v1/rates?source=BRL&target=USD
Headers: Authorization: Bearer <WISE_API_KEY>
```

### Manual

`workspace.config.fx_overrides` jsonb com pares (`{"USD-BRL": 5.20, "date": "2026-05-01"}`). Lido diretamente sem chamada externa.

## Cron

`apps/edge/src/crons/fx-rates-fetch.ts` roda diariamente (UTC 17:00 — após ECB publish):

1. Para cada workspace, lê `fx_normalization_currency`.
2. Identifica pares necessários (cross workspaces que têm gastos em moedas diferentes).
3. Chama provider; cache em CF KV (TTL 25h).
4. Cost ingestor consulta cache em vez de API direto.

## Idempotência

Buscar mesma data 2× retorna mesmo resultado (cache + ECB publish stable). Sem `idempotency_key` específica.

## Retry

3 tentativas com backoff. Se falhar:
- Cost ingestor usa última taxa conhecida (`spend_cents_normalized` ainda preenchido) + flag `fx_stale`.
- Métrica alerta operador.

## Credenciais

```
FX_RATES_PROVIDER=ecb
FX_RATES_API_KEY (apenas Wise)
```

## Adapter

`apps/edge/src/integrations/fx-rates/`:
- `ecb-client.ts`
- `wise-client.ts`
- `manual-resolver.ts`
- `cache.ts` (CF KV wrapper)
- `factory.ts` (escolhe client baseado em env)

## Fixtures

`tests/fixtures/fx-rates/`:
- `ecb-response-xml.txt`
- `wise-response.json`

## Observabilidade

- `fx_rates_fetch_succeeded_total{provider}`
- `fx_rates_fetch_failed_total{provider, error}`
- `ad_spend_daily_using_stale_fx_total` (alerta se > 0)

## Currency de origem — autoridade vem do row Meta (2026-05-14)

A moeda original de cada row Meta vem do campo `account_currency` retornado por `GET /act_{id}/insights`. Esse campo é **autoritativo por conta** e é o input para `resolveMetaRowCurrency` (`apps/edge/src/integrations/meta-insights/client.ts`).

**Risco resolvido em 2026-05-14 (commit `149fbed`):**

- `MetaInsightRowSchema` (Zod) não declarava `account_currency` — o `.strict()` strippava o campo silenciosamente. `resolveMetaRowCurrency` caía sempre no fallback `'USD'` mesmo em contas BRL, e a normalização FX tratava spend BRL como se fosse USD → multiplicava por taxa USD→BRL → inflava ~5× o `spend_cents_normalized`. Após backfill 2026-05-08…14: dashboard "Investimento" passou de `R$ 7.019,03` errado para `R$ 11.638,23` correto.
- Fix em duas camadas:
  1. Schema agora declara `account_currency: z.string().optional()`.
  2. `cost-ingestor.ts` varre o batch antes do loop e cacheia o primeiro `account_currency` válido em `batchAccountCurrency` (Meta às vezes omite em rows agregadas; é estável por conta, então a primeira presença é autoritativa para o batch inteiro).

**Upsert preserva currency atualizada.** O `ON CONFLICT DO UPDATE` em `ad_spend_daily` (`apps/edge/src/crons/cost-ingestor.ts`) inclui `currency = EXCLUDED.currency` desde o fix — re-ingestões sobrescrevem rows legadas USD com a moeda correta da conta. Antes, rows antigas ficavam congeladas com a moeda errada e a re-ingestão só atualizava `spend_cents` / `spend_cents_normalized` / `fx_*`, deixando inconsistência interna na tabela.
