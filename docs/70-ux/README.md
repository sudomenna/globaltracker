# 70 — UX

Design system, IA, wireframes e A11y.

> **Nota de escopo:** o Control Plane (UI operacional) só entra na **Fase 4** do rollout. Esta pasta começa com o esqueleto mínimo; telas detalhadas serão preenchidas quando a Fase 4 for planejada.

| Arquivo | Conteúdo |
|---|---|
| `01-design-system-tokens.md` | Cores, tipografia, espaçamento, raios |
| `02-information-architecture.md` | Sidebar, rotas, command palette, breadcrumbs |
| `03-screen-launch-list.md` | (Fase 4) Lista de lançamentos |
| `04-screen-launch-detail.md` | (Fase 4) Detalhe de lançamento |
| `05-screen-page-registration.md` | (Fase 4) Registro de página + emissão de page_token |
| `06-screen-link-generator.md` | (Fase 4) Gerador de links curtos |
| `07-screen-audience-builder.md` | (Fase 4) Builder de audiences |
| `08-screen-sar-erasure.md` | (Fase 4) UI de SAR/erasure (com double-confirm) |
| `09-interaction-patterns.md` | Realtime, notificações, formulários, erro/loading/empty |
| `10-accessibility.md` | WCAG, teclado, foco |

## Padrão por tela

```md
SCREEN-NN — <nome>
- Objetivo
- PERSONA-* que acessam
- UC-* / FLOW-*
- Wireframe ASCII
- Componentes
- Ações (com Server Action invocada)
- Estados (inicial, loading, empty, erro validação, sucesso, erro servidor)
- Validações
- BRs aplicadas
- Eventos de analytics
- AUTHZ-*
- Notas de A11y/segurança
```
