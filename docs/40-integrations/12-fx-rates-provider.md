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
