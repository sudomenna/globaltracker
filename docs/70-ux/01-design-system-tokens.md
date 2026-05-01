# 01 — Design system tokens

> **Status:** skeleton mínimo. Detalhamento completo na Fase 4 (Control Plane).

## Princípios

- Aproveitar shadcn/ui como base — componentes acessíveis, customizáveis via Tailwind tokens.
- Modo dark obrigatório (operadores trabalham em horários variados).
- Tipografia legível em densidade alta (dashboards têm muitos dados).

## Tokens iniciais

| Categoria | Token | Valor proposto |
|---|---|---|
| Color — primary | `--primary` | brand-defined (TBD Fase 4) |
| Color — destructive | `--destructive` | red-500 (Tailwind) |
| Color — warning | `--warning` | amber-500 |
| Color — success | `--success` | green-500 |
| Color — neutral | `--background`, `--foreground`, `--muted` | shadcn defaults com adjustments |
| Typography — sans | `font-sans` | Inter ou system-ui |
| Typography — mono | `font-mono` | JetBrains Mono ou system mono |
| Spacing | Tailwind scale (4px base) | — |
| Border radius | `--radius` | 0.5rem (default shadcn) |
| Shadow | shadcn levels | sm/md/lg/xl |

## Decisão pendente

OQ a abrir antes da Fase 4:
- Brand color primary do GlobalTracker (logo e identidade visual).
- Fonte de display (se usar diferente da sans).
