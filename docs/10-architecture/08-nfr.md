# 08 — Requisitos não funcionais (NFR)

> Tabela canônica em [`00-product/05-metrics-success.md`](../00-product/05-metrics-success.md). Esta página é o overview técnico operacional.

## Performance

| NFR | Meta inicial | Como verificar |
|---|---|---|
| RNF-001 — `/v1/events` p95 | < 50 ms (modelo fast accept) | Wrangler observability + load test 1000 req/s |
| RNF-001 — `/v1/events` p99 | < 100 ms | mesmo |
| `/v1/lead` p95 | < 100 ms (mais complexo que events) | mesmo |
| `/v1/config` p95 | < 30 ms (cacheable) | mesmo |
| `/r/:slug` p95 | < 50 ms (302 + log async) | mesmo |
| Webhook handlers p95 | < 200 ms (signature + parse + raw_events insert) | mesmo |
| Dispatcher latência (queue → API ext) | p95 < 30s | dispatch_attempts.duration |
| `lead_token` validation overhead | < 5 ms | unit benchmark |

## Disponibilidade

| Componente | Meta inicial | Evolução |
|---|---|---|
| Runtime (Edge + DB) | 99.5% no MVP | 99.9% após Fase 3 |
| Control Plane | 99.0% | 99.5% após Fase 5 |
| Metabase | 99.0% | — |

## Durabilidade

- **RPO (Recovery Point Objective):** ≤ 5 min (Supabase PITR).
- **RTO (Recovery Time Objective):** ≤ 1 hora para Edge; ≤ 4 horas para DB restore.
- DR drill semestral.

## Escalabilidade

| Métrica | Meta MVP (Fase 2) | Plano Fase 3+ |
|---|---|---|
| Eventos/dia por workspace | até 1M | até 10M |
| Workspaces simultâneos | até 5 | até 50 |
| Dispatch jobs/min | até 10k | até 100k |
| `events` row count antes de degradar | 100M (com particionamento) | 1B+ |

Particionamento de `events` por mês permite crescer sem retrabalho. Rollups consultam apenas particições recentes.

## Segurança

| Item | Política |
|---|---|
| TLS | Obrigatório em todas conexões (CF + Supabase nativos) |
| Cookies | `SameSite=Lax`, `Secure`. `__ftk` com `HttpOnly=false` (necessário para tracker); demais com `HttpOnly=true` |
| CORS | Restrito a `pages.allowed_domains` |
| CSP | Implementar em Control Plane; tracker headers permissivos por design |
| Rate limit | Por token, IP, workspace (RNF-011) |
| Token rotation | page_token: 14d overlap; lead_token: TTL 60d; secrets externos: trimestral |
| 2FA | Owner/Admin/Privacy obrigatório (Fase 4) |
| Secret encryption-at-rest | Wrangler secrets + Supabase Vault |
| Audit log | Apenas-anexar, retenção 7 anos |

## Privacidade

| Item | Política |
|---|---|
| PII em logs | Zero (BR-PRIVACY-001) |
| PII em jsonb | Apenas hashes/IDs em chaves canônicas |
| IP/UA | Transitórios; `*_hash` quando persistido |
| Crypto | AES-256-GCM com chave por workspace via HKDF |
| SAR latency | < 60s para lead até 100k events |
| Retenção | Detalhe em ADR-014 e BR-PRIVACY |

## Manutenibilidade

| Item | Meta |
|---|---|
| Cobertura tests | Domain ≥90%, mappers ≥95%, RBAC 100% |
| TypeScript strict | `strict: true`, sem `any` sem justificativa |
| Migrations | Reversíveis quando possível, testadas em DB efêmero |
| Documentação | Doc-sync no mesmo commit (ou `[SYNC-PENDING]` em MEMORY.md) |
| Tempo de onboarding | Novo dev produtivo em < 1 semana |

## Custo (orçamento orientativo, ajustar por uso)

| Recurso | Estimativa MVP | Em escala |
|---|---|---|
| CF Workers (req-based) | < $50/mês | $200-500/mês |
| CF Queues | < $20/mês | $50-150/mês |
| CF KV | < $10/mês | $30-80/mês |
| Supabase | $25-100/mês | $500+/mês |
| Metabase | OSS self-hosted ou $100/mês cloud | $300/mês |

Total esperado MVP: ~$200/mês; em escala (Fase 3+): ~$1k-2k/mês.

## Compliance

- LGPD (Brasil) — operador é controlador; GlobalTracker é operador.
- GDPR (EU) — quando aplicável a leads europeus.
- DPA (Data Processing Agreement) entre operador e GlobalTracker (Fase 4 — quando multi-workspace operacional).
- SOC2 Type II — não previsto MVP; considerar em Fase 5+.

## Acessibilidade (Control Plane Fase 4+)

WCAG 2.1 AA mínimo. Detalhe em [`70-ux/10-accessibility.md`](../70-ux/) (Fase 4).
