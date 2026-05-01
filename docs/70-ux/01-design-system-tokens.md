# 01 — Design System: tokens, components, accessibility

> **Status:** Sprint 6 ready. Aplica skill `.claude/skills/design-system/` sobre input em [`/DESIGN.md`](../../DESIGN.md) (auto-extraído de referência visual Attio).

## 1. Context and goals

GlobalTracker é um Control Plane operacional em formato dashboard (alta densidade de dados, múltiplas tabelas, observabilidade em tempo real). Personas são MARKETER, OPERATOR, ADMIN, PRIVACY — todas trabalhando em monitor desktop, frequentemente em horários variados.

**Objetivo do design system**: garantir consistência, acessibilidade e velocidade de delivery via tokens canônicos e regras prescritivas de componentes. Fonte de verdade para todas as specs em [`docs/70-ux/`](.) e para implementação em [`apps/control-plane/`](../../apps/control-plane/) (Sprint 6+).

Stack: **Next.js 15 + Tailwind + shadcn/ui** (ADR-001). Tokens são expostos em CSS variables em `apps/control-plane/src/styles/tokens.css` e mapeados em `tailwind.config.ts`.

---

## 2. Design tokens and foundations

### 2.1 — Color (dark mode primary)

Modo dark é **default e obrigatório**. Modo light é deferred para Fase 6+ (não impacta Sprint 6).

| Token | Valor | Uso |
|---|---|---|
| `color.text.primary` | `#ffffff` | Headings, valores em destaque, CTAs primários |
| `color.text.secondary` | `#9e9eff` | Subtítulos, labels, metadata, links |
| `color.text.tertiary` | `#4e8cfc` | Texto de ação interativo (hover, active links) |
| `color.surface.base` | `#000000` | Background da app (canvas) |
| `color.surface.muted` | `#1a1d21` | Cards, painéis, modais, sheets |
| `color.surface.strong` | `#15181c` | Surfaces elevadas, popovers, dropdowns |

Cores semânticas (estados — must-haves para [`07-component-health-badges.md`](./07-component-health-badges.md) e padrões de feedback):

| Token | Valor | Uso |
|---|---|---|
| `color.feedback.success` | `#22c55e` (Tailwind green-500) | Health "saudável", success toast |
| `color.feedback.warning` | `#f59e0b` (amber-500) | Health "degraded", warning toast |
| `color.feedback.danger` | `#ef4444` (red-500) | Health "unhealthy", erro destrutivo, validation fail |
| `color.feedback.info` | `#4e8cfc` (≈ tertiary) | Notice neutro, info toast |
| `color.feedback.muted` | `#6b7280` (gray-500) | Health "unknown", disabled |

Brand color primary: **decisão pendente** (OQ a abrir antes do Sprint 6 — ver §10).

### 2.2 — Typography

| Token | Valor |
|---|---|
| `font.family.primary` | `Inter` |
| `font.family.stack` | `Inter, sans-serif` |
| `font.family.mono` | `JetBrains Mono, ui-monospace, monospace` (para code blocks de snippet) |
| `font.size.base` | `10px` |
| `font.size.xs` | `10px` |
| `font.size.sm` | `12px` |
| `font.size.md` | `14px` |
| `font.size.lg` | `16px` |
| `font.size.xl` | `18px` |
| `font.size.2xl` | `24px` |
| `font.weight.regular` | `400` |
| `font.weight.medium` | `500` |
| `font.weight.semibold` | `600` |
| `font.lineHeight.base` | `15px` |
| `font.lineHeight.tight` | `1.25` |
| `font.lineHeight.normal` | `1.5` |

**Nota de A11y**: `font.size.base=10px` é menor que o default do navegador (16px). É aceitável para alta densidade desde que (a) zoom 200% funcione sem clipping, (b) contrast esteja em 7:1+ e (c) componentes interativos usem `font.size.sm` ou maior. **Body de leitura usa `font.size.md` (14px)** — `base=10px` aplica-se apenas a metadata/badges/timestamps secundários. Verificar em [`10-accessibility.md`](./10-accessibility.md).

### 2.3 — Spacing scale

```
space.1 = 1px        space.5 = 6px
space.2 = 2px        space.6 = 7px
space.3 = 3px        space.7 = 8px
space.4 = 4px        space.8 = 10px
space.10 = 12px      space.12 = 16px
space.16 = 24px      space.20 = 32px
space.24 = 48px
```

Baseline grid: `4px`. Steps abaixo de 4px existem para fine-tuning de bordas/insets (raros).

### 2.4 — Radius

| Token | Valor | Uso |
|---|---|---|
| `radius.xs` | `6px` | Badges, chips, tags |
| `radius.sm` | `7px` | Inputs, small buttons |
| `radius.md` | `8px` | Default — buttons, cards pequenos |
| `radius.lg` | `9px` | Cards, modais |
| `radius.xl` | `10px` | Sheets, painéis laterais |
| `radius.2xl` | `18px` | Decorativo, hero cards |

### 2.5 — Shadow

| Token | Valor |
|---|---|
| `shadow.1` | `rgb(47, 48, 51) 0px 0px 0px 1px inset, rgb(0, 0, 0) 0px 0px 2px 0px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px` |
| `shadow.2` | `rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset, rgba(78, 140, 252, 0.12) 0px 2px 4px -2px, rgba(78, 140, 252, 0.08) 0px 3px 6px -2px` (focus / accent) |
| `shadow.3` | `rgb(47, 48, 51) 0px 0px 0px 1px inset` (subtle border on muted surfaces) |

`shadow.2` é o **focus-visible** padrão para inputs/buttons.

### 2.6 — Motion

| Token | Valor | Uso |
|---|---|---|
| `motion.duration.instant` | `100ms` | Hover de borda, micro-feedback |
| `motion.duration.fast` | `140ms` | Tooltip, dropdown open |
| `motion.duration.normal` | `160ms` | Toast slide, sheet open |
| `motion.duration.slow` | `200ms` | Page transitions, large modals |
| `motion.easing.standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | Default |
| `motion.easing.decelerate` | `cubic-bezier(0, 0, 0.2, 1)` | Entrada |
| `motion.easing.accelerate` | `cubic-bezier(0.4, 0, 1, 1)` | Saída |

Usuário com `prefers-reduced-motion: reduce` recebe `duration=0` em todas transições não-essenciais.

---

## 3. Component-level rules

Cada componente do Control Plane **must** definir todos os 7 estados:
**default · hover · focus-visible · active · disabled · loading · error**.

Componentes de baseline (shadcn/ui customizados):

| Componente | Spec local | Variantes |
|---|---|---|
| `<Button>` | (built-in shadcn) | `primary`, `secondary`, `ghost`, `destructive`, `link`; sizes `sm`, `md`, `lg` |
| `<Input>` | shadcn | normal, error, disabled |
| `<Card>` | shadcn | normal, elevated (`shadow.1`), accent (`shadow.2`) |
| `<HealthBadge>` | [`07-component-health-badges.md`](./07-component-health-badges.md) | xs / sm / md; healthy / degraded / unhealthy / unknown / loading |
| `<Tooltip>` | [`08-pattern-contextual-help.md`](./08-pattern-contextual-help.md) | default; with link |
| `<Sheet>` | shadcn | side panels (right) for drill-down |
| `<AlertDialog>` | shadcn | confirmação destrutiva (typed confirm) |
| `<DataTable>` | TanStack Table + shadcn | virtualizada para > 100 rows |
| `<Stepper>` | custom | onboarding wizard ([`03-screen-onboarding-wizard.md`](./03-screen-onboarding-wizard.md)) |
| `<Timeline>` | custom | lead timeline ([`06-screen-lead-timeline.md`](./06-screen-lead-timeline.md)) |
| `<EventStream>` | custom + virtualized | live event console ([`12-screen-live-event-console.md`](./12-screen-live-event-console.md)) |

### 3.1 — Component rule expectations

Toda spec de componente **must** incluir:
- **Keyboard behavior**: tab order, atalhos, Escape, Enter/Space
- **Pointer behavior**: hover, click, drag (quando aplicável)
- **Touch behavior**: tap, long-press (mobile read-only — desktop primário)
- **Spacing/typography tokens**: usados (não valores raw)
- **Long-content handling**: ellipsis, truncate, tooltip on hover
- **Overflow**: scroll local vs page scroll, max-height
- **Empty state**: ilustração + título + CTA + link de help (per [`09-interaction-patterns.md`](./09-interaction-patterns.md))
- **Loading state**: skeleton (não spinner) para listas; spinner inline para ações pontuais
- **Error state**: validation inline (input), toast (acao), full-screen (route fail)

### 3.2 — Responsividade

Control Plane é **desktop-first**. Breakpoints (Tailwind):
- `sm`: ≥ 640px (mobile read-only views)
- `md`: ≥ 768px
- `lg`: ≥ 1024px (entrypoint para todas operações)
- `xl`: ≥ 1280px (target principal)
- `2xl`: ≥ 1536px

Mobile (< 768px): apenas dashboards read-only e detalhes. Sem fluxos de criação/edição.

---

## 4. Accessibility requirements (WCAG 2.2 AA)

Target: **WCAG 2.2 AA**. Detalhe e checklist em [`10-accessibility.md`](./10-accessibility.md).

### Acceptance criteria testáveis

| Critério | Como testar |
|---|---|
| Contrast ratio ≥ 4.5:1 (texto normal) e ≥ 3:1 (texto grande, ícones) | axe-core; manual: lighthouse |
| Focus-visible em todo interativo | Tab pelos elementos; verificar `shadow.2` aplicado |
| Keyboard-first navigation | Operar tela completa sem mouse |
| Tap target mínimo 24x24px (WCAG 2.2 — Target Size — Minimum) | Inspecionar buttons/links em mobile |
| `aria-label` em ícones-only buttons | grep + axe |
| `aria-live` em conteúdo que muda dinamicamente (toast, console live, badge polling) | Manual com NVDA/VoiceOver |
| Color não isolada (sempre cor + ícone + texto para estados) | grep `<HealthBadge>` etc. |
| Zoom 200% sem clipping nem scroll horizontal | Browser zoom + Ctrl+= 2 vezes |
| `prefers-reduced-motion` respeitado | DevTools → emulate reduced motion |
| Form: labels associados, error com `aria-describedby` | Manual + axe |

### CI gate
- `axe-core` rodando em `tests/a11y/` para todos os componentes shadcn customizados e screens novas
- Zero violations em build de produção

---

## 5. Content and tone standards

Resumo (detalhamento em [`11-copy-deck-skip-messages.md`](./11-copy-deck-skip-messages.md)):

- **Tom**: conciso, confiante, implementation-focused. PT-BR.
- **Voz**: passiva quando descreve sistema ("Não foi possível X"); ativa quando solicita ação do usuário ("Configure o Pixel ID").
- **Não culpar usuário** ("não foi possível X" > "você fez Y errado").
- **Termos consagrados em inglês permitidos**: "Pixel", "API", "token", "gclid", "fbp", "DLQ" — listados em [`docs/00-product/06-glossary.md`](../00-product/06-glossary.md).
- **Comprimento**: título ≤ 6 palavras; corpo ≤ 2 frases; ações em verbo no infinitivo ("Configurar agora").

### Exemplos

| Contexto | ✅ Faça | ❌ Evite |
|---|---|---|
| Skip de dispatch | "Lead negou consentimento para anúncios" | "consent_denied:ad_user_data" |
| Empty state | "Nenhum lançamento ainda · [Criar primeiro lançamento]" | "Sem dados" |
| Erro de validação | "Pixel ID precisa ter 15 ou 16 dígitos" | "Invalid format" |
| Loading | "Carregando lançamentos..." (skeleton) | spinner solo + "Loading" |

---

## 6. Anti-patterns and prohibited implementations

### Não faça

- ❌ **Valores hex/px raw em componentes**. Use sempre tokens (`color.feedback.danger`, `space.4`).
- ❌ **One-off spacing/typography**. Se precisar, abra ADR antes de adicionar.
- ❌ **Cor isolada para indicar estado**. Sempre cor + ícone + texto/aria-label.
- ❌ **Spinner para listas/dashboards**. Use skeleton screens.
- ❌ **Modal sem foco trap + Escape** para fechar.
- ❌ **Confirmação destrutiva sem typed confirm** ("Type ERASE LEAD <id>") — ver [`09-interaction-patterns.md §4`](./09-interaction-patterns.md).
- ❌ **Hidden focus indicators** (`outline: none` sem substituto visível).
- ❌ **Labels ambíguos**: "Submit", "OK", "Confirm" — use verbo + objeto ("Criar lançamento", "Rotacionar token").
- ❌ **Componente sem todos 7 estados** (default/hover/focus-visible/active/disabled/loading/error).
- ❌ **Animação > 200ms** em interações comuns (causa percepção de lentidão).

### Migration notes

Ao consumir componente shadcn que use defaults diferentes destes tokens:
1. Override via `tailwind.config.ts` (extend theme com nossos tokens)
2. Não editar source do componente shadcn — apenas wrapper local em `apps/control-plane/src/components/ui/`

---

## 7. QA checklist (per-component)

Antes de PR de qualquer componente novo ou alterado:

- [ ] Usa apenas tokens (zero hex/px raw)
- [ ] Todos 7 estados implementados (default/hover/focus-visible/active/disabled/loading/error)
- [ ] Storybook ou exemplo isolado em `apps/control-plane/src/components/__demos__/`
- [ ] Testes unit cobrindo cada estado
- [ ] `axe-core` zero violations
- [ ] Keyboard operation: tab order documentado, Escape fecha overlays, Enter/Space ativa
- [ ] `aria-label` em ícones-only
- [ ] Empty/long-content/overflow tratados
- [ ] Responsivo: testado em `lg` (alvo), degrada graceful em `md`/`sm`
- [ ] `prefers-reduced-motion` respeitado
- [ ] Storybook docs com tokens usados explícitos
- [ ] Spec em [`docs/70-ux/`](.) atualizada se for componente compartilhado

---

## 8. Implementação concreta (Sprint 6)

### 8.1 — `apps/control-plane/src/styles/tokens.css`

```css
:root {
  /* Color */
  --color-text-primary: #ffffff;
  --color-text-secondary: #9e9eff;
  --color-text-tertiary: #4e8cfc;
  --color-surface-base: #000000;
  --color-surface-muted: #1a1d21;
  --color-surface-strong: #15181c;
  --color-feedback-success: #22c55e;
  --color-feedback-warning: #f59e0b;
  --color-feedback-danger: #ef4444;
  --color-feedback-info: #4e8cfc;
  --color-feedback-muted: #6b7280;

  /* Typography */
  --font-family-primary: 'Inter', sans-serif;
  --font-family-mono: 'JetBrains Mono', ui-monospace, monospace;
  --font-size-base: 10px;
  --font-size-md: 14px;

  /* Spacing */
  --space-4: 4px;
  --space-7: 8px;
  --space-12: 16px;

  /* Radius */
  --radius-md: 8px;
  --radius-lg: 9px;

  /* Shadow */
  --shadow-1: rgb(47, 48, 51) 0px 0px 0px 1px inset, rgb(0, 0, 0) 0px 0px 2px 0px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px;
  --shadow-2: rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset, rgba(78, 140, 252, 0.12) 0px 2px 4px -2px, rgba(78, 140, 252, 0.08) 0px 3px 6px -2px;

  /* Motion */
  --motion-duration-fast: 140ms;
  --motion-duration-normal: 160ms;
  --motion-easing-standard: cubic-bezier(0.4, 0, 0.2, 1);
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0ms !important;
    transition-duration: 0ms !important;
  }
}
```

### 8.2 — `apps/control-plane/tailwind.config.ts` (extract)

```ts
export default {
  theme: {
    extend: {
      colors: {
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          tertiary: 'var(--color-text-tertiary)',
        },
        surface: {
          base: 'var(--color-surface-base)',
          muted: 'var(--color-surface-muted)',
          strong: 'var(--color-surface-strong)',
        },
        feedback: {
          success: 'var(--color-feedback-success)',
          warning: 'var(--color-feedback-warning)',
          danger: 'var(--color-feedback-danger)',
          info: 'var(--color-feedback-info)',
          muted: 'var(--color-feedback-muted)',
        },
      },
      fontFamily: {
        sans: ['var(--font-family-primary)'],
        mono: ['var(--font-family-mono)'],
      },
      borderRadius: {
        xs: '6px',
        sm: '7px',
        md: '8px',
        lg: '9px',
        xl: '10px',
        '2xl': '18px',
      },
      transitionDuration: {
        instant: '100ms',
        fast: '140ms',
        normal: '160ms',
        slow: '200ms',
      },
    },
  },
};
```

---

## 9. Manutenção e evolução

- Tokens **must** ser referenciados via CSS variables. Nunca hardcoded em JSX/CSS.
- Mudança de token = ADR + atualização desta spec + revisão de consumidores.
- Re-extração via skill `.claude/skills/design-system/` produz novo `DESIGN.md` no root — comparar manualmente com esta spec; aplicar mudanças via PR.

---

## 10. Open Questions / pendências

- **OQ-008** (a abrir antes de Sprint 6): Brand color primary do GlobalTracker (logo + identidade visual). Atualmente usando `text.tertiary=#4e8cfc` como accent.
- **OQ-009**: Fonte de display/headings (Inter para tudo, ou par com display font).
- **OQ-010**: Suporte a modo light (Fase 6+ — não bloqueia Sprint 6).

---

## 11. Referências

- Input auto-extraído: [`/DESIGN.md`](../../DESIGN.md) (gerado por skill `.claude/skills/design-system/`)
- Skill: [`.claude/skills/design-system/SKILL.md`](../../.claude/skills/design-system/SKILL.md)
- shadcn/ui: https://ui.shadcn.com
- Tailwind: https://tailwindcss.com
- WCAG 2.2 AA: https://www.w3.org/WAI/WCAG22/quickref/
- [`02-information-architecture.md`](./02-information-architecture.md) — sidebar, rotas
- [`09-interaction-patterns.md`](./09-interaction-patterns.md) — loading/error/empty/destructive
- [`10-accessibility.md`](./10-accessibility.md) — checklist completo WCAG 2.2 AA
- [`11-copy-deck-skip-messages.md`](./11-copy-deck-skip-messages.md) — copy canônico
