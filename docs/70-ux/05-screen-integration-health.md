# 05 — SCREEN: Integration Health & Test

> **Status:** Sprint 6. Implementa itens B.2 + D.1 + D.2 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Tela única por integração externa (Meta CAPI, GA4 MP, Google Ads, Hotmart/Stripe webhooks etc.)
combinando:
- **Card de saúde** com métricas das últimas 24h e drill-down em `dispatch_attempts` (B.2)
- **Botão "Disparar evento de teste"** validando ponta-a-ponta (D.1)
- **Deep-links contextualizados** para ferramentas nativas (D.2)
- **Configuração + checklist** (do A.2 do wizard, agora editável)

## Rotas

- `/integrations` — lista
- `/integrations/meta` — Meta CAPI
- `/integrations/ga4` — GA4 Measurement Protocol
- `/integrations/google-ads` — Google Ads Conversion Upload
- `/integrations/webhooks/:provider` — Hotmart, Stripe, Kiwify, etc.

## AUTHZ

- **Visualizar:** OPERATOR, ADMIN, MARKETER
- **Editar credenciais:** OPERATOR, ADMIN
- **Disparar teste:** OPERATOR, ADMIN, MARKETER (mas só após credenciais salvas)
- **Ver payload bruto em `dispatch_attempts`:** OPERATOR+ (MARKETER vê payload sanitizado/parcial)
- **Re-dispatch / requeue DLQ:** OPERATOR, ADMIN

---

## 1. Layout

```
Integrações > Meta CAPI

┌─ Saúde (últimas 24h) ────────────────────────────────────┐
│ ● Saudável                                              │
│                                                          │
│ ✓ 1.247 eventos enviados                                 │
│ ⚠ 12 ignorados (consent negado)                          │
│ ✗ 3 falharam                                             │
│ Latência média: 340ms                                    │
│ Match Quality Score: 7.8/10                              │
│                                                          │
│ [Ver últimas 100 tentativas →]                           │
└──────────────────────────────────────────────────────────┘

┌─ Testar configuração ────────────────────────────────────┐
│ Dispara um evento sintético com test_event_code para     │
│ validar credenciais e domínio sem afetar produção.       │
│                                                          │
│ [Disparar evento de teste]                               │
│                                                          │
│ Últimos testes:                                          │
│   ✓ há 12min — Meta confirmou recebimento (lat 312ms)    │
│   ✓ há 1h — Meta confirmou recebimento (lat 287ms)       │
│   ✗ há 3h — domínio não verificado [Detalhes]            │
└──────────────────────────────────────────────────────────┘

┌─ Configuração ───────────────────────────────────────────┐
│ Pixel ID:        [123456789012345________]  ⓘ            │
│ Token CAPI:      [********************pk_]  [Renovar]    │
│ Test Event Code: [TEST12345____________]    (opcional)   │
│                                                          │
│ Atalhos no Meta:                                         │
│   [Abrir Events Manager ↗] [Domain Verification ↗]       │
│   [Aggregated Event Measurement ↗]                       │
│                                                          │
│ Checklist de pré-requisitos:                             │
│   ☑ Pixel ID válido (verificado em /test-config)         │
│   ☑ Token CAPI válido (verificado em /test-config)       │
│   ☑ Domínios LP verificados no Meta                      │
│   ☑ AEM priorizado (iOS 14+)                             │
│                                                          │
│   [Salvar configuração]                                  │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Drill-down: dispatch attempts (B.2)

Click em "Ver últimas 100 tentativas" abre tabela:

```
Últimas tentativas — Meta CAPI                  [Filtros ▼]

┌────────┬──────────┬─────────┬──────────┬────────┬─────────┐
│ Quando │ Evento   │ Lead    │ Status   │ Latência│ Ações  │
├────────┼──────────┼─────────┼──────────┼────────┼─────────┤
│ há 3s  │ Lead     │ ld_abc  │ ✓ ok     │ 312ms  │ [Ver]  │
│ há 12s │ PageView │ —       │ ✓ ok     │ 287ms  │ [Ver]  │
│ há 1m  │ Lead     │ ld_xyz  │ ⚠ skip   │ —      │ [Ver]  │
│        │          │         │ consent_ │        │        │
│        │          │         │ denied   │        │        │
│ há 2m  │ Purchase │ ld_def  │ ✗ falha  │ 412ms  │ [Ver]  │
│        │          │         │ invalid_ │        │        │
│        │          │         │ pixel    │        │        │
└────────┴──────────┴─────────┴──────────┴────────┴─────────┘

Filtros: status (ok/skip/falha) | evento | lead | últimas 24h ▾
```

Click em [Ver] abre painel lateral com `dispatch_attempts` row:
- Request payload (sanitizado para MARKETER, completo para OPERATOR)
- Response code + body sanitizado
- Latência, attempt_number, retry_strategy
- `error_code` traduzido via [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md)
- Botão `[Tentar novamente]` se `dead_letter` (OPERATOR/ADMIN — confirmação destrutiva)
- Link `[Ver no Meta Events Manager ↗]` com `event_id` no path quando aplicável

---

## 3. Test event flow (D.1)

Click em "Disparar evento de teste":

```
Testando configuração...

[ Sistema ] ─→ [ Meta CAPI ] ─→ [ Meta Events Manager ]
   ✓ ok          ⏳ enviando        ⏳ aguardando

(2-5 segundos)

[ Sistema ] ─→ [ Meta CAPI ] ─→ [ Meta Events Manager ]
   ✓ ok          ✓ entregue        ✓ visível

✅ Tudo funcionando.
   [Ver no Meta Events Manager ↗]   [Disparar outro]
```

Caso de erro:
```
[ Sistema ] ─→ [ Meta CAPI ] ─→ [ Meta Events Manager ]
   ✓ ok          ✗ falhou           —

⚠️ Domínio não verificado no Meta
   O Meta rejeitou o evento porque lp.cliente.com não está
   verificado no Business Manager.

   [Abrir Domain Verification ↗]   [Tentar novamente]
```

Implementação:
- `POST /v1/integrations/meta/test` com body `{ source: 'config_screen' }`
- Backend gera evento sintético (`event_name='TestEvent'`, `event_id` único, sem PII)
- Envia com `META_CAPI_TEST_EVENT_CODE` configurado (ou cria temporário)
- Persiste em `integration_health_checks` (KV ou tabela)
- Response stream/long-poll com fases (sistema → CAPI → confirmação)

---

## 4. Deep-links contextualizados (D.2)

Tabela canônica de deep-links por integração:

| Integração | Recurso | Deep-link template |
|---|---|---|
| Meta CAPI | Events Manager (geral) | `https://business.facebook.com/events_manager2/list/pixel/<pixel_id>` |
| Meta CAPI | Test Events | `.../pixel/<pixel_id>/test_events` |
| Meta CAPI | Diagnostics | `.../pixel/<pixel_id>/diagnostics` |
| Meta | Domain Verification | `https://business.facebook.com/settings/owned-domains` |
| Meta | Aggregated Event Measurement | `https://business.facebook.com/events_manager2/list/pixel/<pixel_id>/aggregated_event_measurement` |
| GA4 | DebugView | `https://analytics.google.com/analytics/web/#/p<property_id>/realtime/debugview` |
| GA4 | Realtime | `https://analytics.google.com/analytics/web/#/p<property_id>/realtime/overview` |
| GA4 | Data Streams | `https://analytics.google.com/analytics/web/#/a<account_id>p<property_id>/admin/streams/table` |
| Google Ads | Conversion Actions | `https://ads.google.com/aw/conversions` |
| Google Ads | Conversion (specific) | `https://ads.google.com/aw/conversions/detail?conversionId=<conversion_id>` |

Helper: `apps/control-plane/src/lib/deep-links.ts` exportando `metaPixelTestEvents(pixelId)`,
`ga4DebugView(propertyId)`, etc. **Sempre abrir em nova aba** (`target="_blank" rel="noopener"`).

Quando o ID necessário não está disponível (ex.: `property_id` GA4 não capturado),
deep-link cai para a página geral da ferramenta.

---

## 5. Lista global `/integrations`

```
Integrações                                    [+ Adicionar]

┌────────────────────┬──────────┬─────────────┬────────────┐
│ Integração         │ Saúde    │ 24h         │ Ações      │
├────────────────────┼──────────┼─────────────┼────────────┤
│ Meta CAPI          │ ●        │ 1.247 ✓ 3✗  │ [Configurar]│
│ Google Analytics 4 │ ●        │ 982 ✓       │ [Configurar]│
│ Google Ads         │ ●        │ —           │ [Configurar]│
│ Hotmart webhook    │ ●        │ 47 ✓        │ [Configurar]│
│ Stripe webhook     │ ○        │ —           │ [Conectar] │
└────────────────────┴──────────┴─────────────┴────────────┘
```

`<HealthBadge size="xs">` por linha. Click na linha leva à `/integrations/:provider`.

---

## 6. Componentes shadcn

- `<Card>` para cada bloco
- `<Form>` + `<FormField>` (config)
- `<DataTable>` para drill-down de dispatch_attempts (TanStack Table)
- `<Sheet>` (slide-over) para detalhes de attempt
- `<HealthBadge>` ([07-component-health-badges.md](./07-component-health-badges.md))
- `<Stepper>` horizontal compacto para fluxo de teste (sistema → CAPI → confirmação)
- `<Alert>` para erros de teste
- `<Tooltip>` em ⓘ
- `<Button variant="ghost">` para deep-links (com ícone `ExternalLink`)

---

## 7. Estados

- **Loading saúde:** skeleton no card, polling 60s em background
- **Loading drill-down:** spinner + "Carregando últimas 100 tentativas"
- **Empty 24h (integração nova):** "Nenhum evento ainda — dispare um teste para validar"
- **Empty drill-down:** "Sem tentativas registradas no período"
- **Erro fetching:** "Não foi possível carregar saúde. Última atualização: HH:MM"

---

## 8. Endpoints consumidos

- `GET /v1/integrations` — lista resumida com `health_state` por provider
- `GET /v1/integrations/:provider` — detalhe de config
- `PATCH /v1/integrations/:provider` — atualizar credenciais (audit log)
- `GET /v1/integrations/:provider/health` — saúde 24h
- `GET /v1/integrations/:provider/attempts?limit=100&filter=...` — drill-down
- `POST /v1/integrations/:provider/test` — D.1
- `GET /v1/integrations/:provider/test-history` — últimos testes
- `POST /v1/dispatch-jobs/:id/replay` — re-dispatch (E.3, mas usável aqui também)

---

## 9. AUTHZ por elemento

| Elemento | MARKETER | OPERATOR | ADMIN | PRIVACY |
|---|---|---|---|---|
| Ver card saúde | ✓ | ✓ | ✓ | ✓ |
| Ver lista de attempts | ✓ (sanitizada) | ✓ | ✓ | ✓ (sem PII) |
| Ver payload de attempt | parcial | full | full | hash apenas |
| Editar credenciais | ✗ | ✓ | ✓ | ✗ |
| Disparar teste | ✓ | ✓ | ✓ | ✗ |
| Re-dispatch / requeue | ✗ | ✓ | ✓ | ✗ |
| Deep-links externos | ✓ | ✓ | ✓ | ✓ |

---

## 10. A11y

- Health badge sempre tem texto descritivo além de cor
- Tabela de attempts navegável por teclado, sortável com `aria-sort`
- Stepper de teste anuncia mudança de fase via `aria-live="polite"`
- Deep-links externos com `aria-label` explícito ("Abrir Meta Events Manager em nova aba")
- Confirmação de re-dispatch via `<AlertDialog>` com foco trap

---

## 11. Test harness

- `tests/integration/control-plane/integration-health.test.tsx` — render saúde + drill-down
- `tests/integration/control-plane/integration-test.test.tsx` — happy path + 3 cenários de falha
- `tests/integration/control-plane/dispatch-attempts-drilldown.test.tsx` — paginação, filtros, AUTHZ payload
- `tests/unit/control-plane/deep-links.test.ts` — geração correta de URLs por provider
- E2E: "MARKETER configura Meta CAPI via wizard e dispara teste com sucesso" ([docs/80-roadmap/98-test-matrix-by-sprint.md](../80-roadmap/98-test-matrix-by-sprint.md))

---

## 12. Referências

- [02-information-architecture.md](./02-information-architecture.md) — rotas
- [07-component-health-badges.md](./07-component-health-badges.md) — `<HealthBadge>`
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — mensagens
- [40-integrations/01-meta-capi.md](../40-integrations/01-meta-capi.md) — Meta CAPI
- [40-integrations/06-ga4-measurement-protocol.md](../40-integrations/06-ga4-measurement-protocol.md) — GA4 MP
- [50-business-rules/BR-DISPATCH.md](../50-business-rules/BR-DISPATCH.md) — `dispatch_jobs` lifecycle
- [10-architecture/07-observability.md](../10-architecture/07-observability.md) — `dispatch_health_view`
