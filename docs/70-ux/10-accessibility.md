# 10 — Accessibility (WCAG 2.2 AA)

> **Status:** Sprint 6 ready. Standard alinhado a [`01-design-system-tokens.md §4`](./01-design-system-tokens.md).

## Standard

**WCAG 2.2 nível AA** mínimo em Control Plane. WCAG 2.2 adicionou critérios sobre Target Size (Minimum), Focus Appearance, Dragging Movements, Consistent Help — todos cobertos abaixo.

## Princípios

| Categoria | Critério |
|---|---|
| Contraste texto normal | ≥ 4.5:1 |
| Contraste texto grande (≥ 18.66px regular ou 14px bold) | ≥ 3:1 |
| Contraste UI components / focus indicator | ≥ 3:1 |
| Tamanho mínimo de texto interativo | `font.size.sm` (12px) — `font.size.base` (10px) só para metadata estática |
| Tamanho mínimo de tap target (WCAG 2.2 — 2.5.8) | 24×24 CSS pixels |
| Foco visível (WCAG 2.2 — 2.4.11) | Token `shadow.2` em todo elemento interativo. **Nunca `outline: none`** sem substituto |
| Navegação por teclado | Tab order lógico; Esc fecha overlays; Enter/Space ativa botões |
| Screen reader | `aria-label` em ícones-only; `aria-describedby` para help texts; live regions para feedback |
| Movimento | `prefers-reduced-motion: reduce` zera transições não-essenciais |
| Idioma | `lang="pt-BR"` no `<html>` |
| Form labels | `<label for="...">` ou `aria-label` explícito; nunca placeholder como label |
| Color isolation | Estado **never** indicado só por cor — sempre cor + ícone + texto/aria |
| Drag operations (WCAG 2.2 — 2.5.7) | Toda ação de drag tem alternativa por click/keyboard |
| Help consistency (WCAG 2.2 — 3.2.6) | Help/contato em mesma posição em toda tela ([`08-pattern-contextual-help.md`](./08-pattern-contextual-help.md)) |
| Authentication (WCAG 2.2 — 3.3.8) | Login não exige memorização ou cálculo (cobrado por SSO/2FA fluxo padrão) |

## Tokens semânticos relevantes

| Uso | Token |
|---|---|
| Focus ring | `shadow.2` (já contém ring + glow) |
| Estado erro inline | `color.feedback.danger` + ícone `XCircle` + `aria-invalid="true"` |
| Estado sucesso | `color.feedback.success` + ícone `CheckCircle` |
| Estado warning | `color.feedback.warning` + ícone `AlertTriangle` |

Ver [`01-design-system-tokens.md`](./01-design-system-tokens.md).

## Componentes shadcn (baseline) + customizações

shadcn/ui usa Radix Primitives, que já implementa A11y robusta:
- Foco trap em `<Dialog>`, `<Sheet>`, `<AlertDialog>`
- Escape fecha overlays
- `aria-*` em `<DropdownMenu>`, `<Tooltip>`, `<Tabs>`
- Suporte a portal para overlays não trap

**Validar em PR** todo componente customizado em `apps/control-plane/src/components/`:
- `<HealthBadge>` ([`07-component-health-badges.md`](./07-component-health-badges.md)) — texto + ícone + aria-label
- `<Timeline>` ([`06-screen-lead-timeline.md`](./06-screen-lead-timeline.md)) — equivalente em lista para SR
- `<EventStream>` ([`12-screen-live-event-console.md`](./12-screen-live-event-console.md)) — `aria-live` filtrado
- `<Stepper>` ([`03-screen-onboarding-wizard.md`](./03-screen-onboarding-wizard.md)) — `aria-current="step"`

## Testes (CI gate)

- **axe-core** integration test obrigatória em `tests/a11y/` para toda screen e componente shadcn customizado. Zero violations em CI.
- **Lighthouse a11y score ≥ 95** em rotas principais (build pipeline).
- **Spot check com NVDA + VoiceOver** mensal para fluxos críticos (onboarding, lead detail, integrations health).
- **Axe linter** (eslint-plugin-jsx-a11y) em todo `.tsx`.
- **Color contrast check** automatizado: `apps/control-plane/scripts/check-contrast.ts` valida pares text-on-surface contra threshold WCAG 2.2 AA.

## Acceptance criteria testáveis (resumo)

| Critério | Como testar |
|---|---|
| Contrast ≥ 4.5:1 texto normal | axe; manual lighthouse |
| Focus-visible em todo interativo | Tab; verificar `shadow.2` |
| Keyboard-first | Operar tela completa sem mouse |
| Tap target ≥ 24×24px | Inspect button/link em mobile |
| `aria-label` em ícone-only | grep + axe |
| `aria-live` em conteúdo dinâmico (toast, console live, badge polling) | Manual NVDA/VoiceOver |
| Color não isolada para estado | grep `<Badge>` etc.; checar variant + ícone + aria |
| Zoom 200% sem clipping | `Ctrl+= 2x` |
| `prefers-reduced-motion` respeitado | DevTools emulate |
| Form: label associado, error com `aria-describedby` | Manual + axe |

## Casos críticos

### Modal de confirmação destrutiva (ex.: SAR/erasure)
- Foco trapado dentro da modal
- Escape cancela (não confirma)
- Screen reader anuncia conteúdo via `role="alertdialog"`
- Botão destrutivo desabilitado até typed confirm correto
- Auto-focus no campo de confirmação ao abrir

### Tabela com paginação cursor-based
- Botão "Carregar mais" tem `aria-label` explícito incluindo contexto ("Carregar próximas 50 tentativas")
- Status "carregando próxima página" anunciado via `aria-live="polite"`
- Loading skeleton tem `aria-busy="true"`

### Toast / notificações
- Toast de erro: `role="alert"` ou `aria-live="assertive"`
- Toast de confirmação: `aria-live="polite"`
- Auto-dismiss ≥ 5s (4s mínimo per WCAG 2.2 — 2.2.1 Timing Adjustable, mas com `pauseable`)

### Live Event Console
- Stream de eventos não anuncia cada evento (overload). `aria-live="polite"` apenas quando filtros mudam ou estado de conexão muda.
- "Pause" tem atalho de teclado (Space) anunciado via `aria-keyshortcuts`.

### Onboarding Wizard
- Stepper: `aria-current="step"` no passo ativo
- Cada passo tem heading ID-correlated com `aria-labelledby` no painel
- "Pular" sempre acessível por Tab (não escondido em hover-only)

## Auditoria contínua

- Quarterly: full-page audit com NVDA + VoiceOver pelos fluxos top-3 do MARKETER e top-3 do OPERATOR
- Em todo PR que toca componente compartilhado: rodar axe local antes de push
- Integrations test inclui `axe-core` para cada screen nova ([`docs/70-ux/03-08, 11-12`](.))

## Referências

- WCAG 2.2 quickref: https://www.w3.org/WAI/WCAG22/quickref/
- shadcn/ui A11y: https://ui.shadcn.com/docs (cada componente lista compliance)
- Radix Primitives: https://www.radix-ui.com/primitives
- `eslint-plugin-jsx-a11y`: https://github.com/jsx-eslint/eslint-plugin-jsx-a11y
