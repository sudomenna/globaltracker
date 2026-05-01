# 60 — Fluxos E2E

Comportamentos que **atravessam módulos**. Cada FLOW-NNN gera 1 spec Playwright em `tests/e2e/`.

| Arquivo | Flow | Origem (planejamento.md) |
|---|---|---|
| `01-register-lp-and-install-tracking.md` | FLOW-01 — Registrar LP externa e instalar tracking | UC-001 |
| `02-capture-lead-and-attribute.md` | FLOW-02 — Capturar lead e atribuir origem | UC-002 |
| `03-send-lead-to-meta-capi-with-dedup.md` | FLOW-03 — Enviar Lead para Meta CAPI com deduplicação | UC-003 |
| `04-register-purchase-via-webhook.md` | FLOW-04 — Registrar Purchase via webhook | UC-004 |
| `05-sync-icp-audience.md` | FLOW-05 — Sincronizar público ICP | UC-005 |
| `06-performance-dashboard.md` | FLOW-06 — Dashboard de performance | UC-006 |
| `07-returning-lead-initiate-checkout.md` | FLOW-07 — Lead retornante dispara InitiateCheckout | UC-007 |
| `08-merge-converging-leads.md` | FLOW-08 — Merge de leads convergentes | UC-008 |
| `09-erasure-by-sar.md` | FLOW-09 — Erasure por SAR | UC-009 |

## Formato obrigatório

Cada flow tem:
- Gatilho.
- Atores (PERSONA-*).
- Casos de uso envolvidos (UC-*).
- Telas relacionadas (SCREEN-*).
- Módulos atravessados (MOD-*).
- Contratos envolvidos (CONTRACT-*).
- BRs aplicadas.
- **Passos numerados e determinísticos** (sem "talvez").
- Fluxos alternativos (mín. 2 caminhos infelizes).
- Pós-condições.
- Eventos de timeline emitidos (TE-*).
- Erros previstos (link para `30-contracts/`).
- Casos de teste E2E sugeridos (mín. 3).
