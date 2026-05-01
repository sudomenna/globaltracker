# 10 — Acessibilidade

> **Status:** skeleton. Implementação detalhada na Fase 4.

## Standard

WCAG 2.1 nível AA mínimo em Control Plane.

## Princípios

| Categoria | Mínimo |
|---|---|
| Contraste | 4.5:1 para texto normal; 3:1 para texto grande |
| Tamanho mínimo de texto | 14px (16px preferido) |
| Foco visível | Outline customizado (não default browser) em todos elementos interativos |
| Navegação por teclado | Tab order lógico; Esc fecha modais; Enter ativa botões |
| Screen reader | aria-* labels em todos botões/links; live regions para notificações |
| Movimento | Respeitar `prefers-reduced-motion` |
| Idioma | `lang="pt-BR"` no html root |
| Form labels | Sempre `<label for="...">` ou `aria-label` explícito |

## Componentes shadcn

shadcn/ui já implementa boa parte (Radix primitives). Validar em audit por componente customizado.

## Testes

- Lighthouse a11y score ≥ 90 em rotas principais.
- axe-core integration test em CI.
- Spot check com NVDA/VoiceOver mensalmente.

## Casos críticos

- **Modal de confirmação destrutiva** (SAR): foco trapped, Esc cancela, leitor de tela anuncia conteúdo da modal.
- **Tabela com paginação**: status de "carregando próxima página" anunciado para screen reader.
- **Toast de erro**: aria-live="assertive" para erros críticos; "polite" para confirmações.
