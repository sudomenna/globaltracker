# 08 — Pattern: Contextual Help & In-app Documentation

> **Status:** Sprint 6. Implementa itens F.1 + F.2 + F.3 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Padrão transversal para ajuda inline em todo Control Plane. Três camadas:
1. **Tooltips** em campos técnicos (F.1) — explicação curta + link aprofundado
2. **Glossário in-app** `/help/glossary` (F.2) — fonte canônica de termos
3. **"Por que isso aconteceu?"** (F.3) — painel lateral em qualquer erro/skip

MARKETER nunca precisa abrir doc externa para entender o produto.

---

## 1. F.1 — Tooltips em campos técnicos

### 1.1 — Quando usar tooltip
Toda label cuja tradução literal **não é evidente** para MARKETER:
- Termos técnicos (fbp, gclid, idempotency key, page token, fbc)
- Acrônimos (CAPI, MP, AEM, SAR, ICP)
- Conceitos do produto (lead resolver, attribution touch, dispatch job)
- Configurações com efeito não-óbvio (event time clamp window, retry policy)

### 1.2 — Quando NÃO usar
- Labels já em PT-BR claro ("Nome", "Email", "Domínio")
- Textos que cabem em hint inline abaixo do campo (use `<FormDescription>` shadcn)

### 1.3 — Anatomia

```
Pixel ID  ⓘ
[__________________]
```

Hover/focus em ⓘ:
```
┌────────────────────────────────────────────────┐
│ Pixel ID                                       │
│                                                │
│ Identificador único do seu Meta Pixel.         │
│ Encontre em business.facebook.com →            │
│ Events Manager → Pixel.                        │
│                                                │
│ [Saber mais ↗]  [Ver no glossário ↗]           │
└────────────────────────────────────────────────┘
```

### 1.4 — Componente

```tsx
// apps/control-plane/src/components/help-tooltip.tsx
import { glossary } from '@/lib/glossary';

interface HelpTooltipProps {
  term: keyof typeof glossary;        // chave canônica do glossário
  size?: 'sm' | 'md';
}

<Label>
  Pixel ID <HelpTooltip term="meta_pixel_id" />
</Label>
```

Componente lê do glossário central — **proibido inline copy**. Se termo não existe no
glossário, build falha (lint rule).

### 1.5 — Comportamento

- Hover desktop: abre após 300ms
- Focus teclado: abre imediatamente
- Click mobile: abre fixed (não hover)
- Escape fecha
- `aria-describedby` no campo aponta para o tooltip

---

## 2. F.2 — Glossário in-app

### 2.1 — Rota
`/help/glossary` — acessível por todos os roles autenticados, sempre via sidebar (item Help).

### 2.2 — Layout

```
Glossário                                    [Buscar ▼]

A   B   C   D   E   F   G   ... (jump links)

A
─────────────────────────────────────────────────────────
Aggregated Event Measurement (AEM)
   Mecanismo do Meta para iOS 14+ que limita medição
   de eventos em ads. Exige priorização de eventos.
   [Aprofundar ↗]   [Onde aparece no produto?]

Atribuição (first-touch / last-touch)
   ...

C
─────────────────────────────────────────────────────────
CAPI (Conversions API)
   ...
```

Cada entrada tem:
- **Termo** (PT-BR + sigla original quando aplicável)
- **Definição curta** (≤ 3 frases)
- **Link "Aprofundar ↗"** para doc canônica externa
- **Link "Onde aparece no produto?"** — lista de telas onde o termo é usado

### 2.3 — Fonte de verdade

Arquivo único: `apps/control-plane/src/lib/glossary.ts` exportando objeto:

```ts
export const glossary = {
  meta_pixel_id: {
    term: 'Pixel ID',
    short: 'Identificador único do seu Meta Pixel.',
    long: 'Encontre em business.facebook.com → Events Manager → Pixel.',
    externalLink: 'https://business.facebook.com/business/help/952192354843755',
    appearsIn: ['/integrations/meta', '/onboarding'],
  },
  fbp: {
    term: 'fbp',
    short: 'Cookie do Pixel do Meta. Identifica o navegador.',
    long: 'Cookie de primeiro lado setado pelo Meta Pixel...',
    externalLink: 'https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters',
    appearsIn: ['/leads/:id/timeline', '/integrations/meta'],
  },
  // ...
} as const;
```

Build a partir do [docs/00-product/06-glossary.md](../00-product/06-glossary.md) — script
`apps/control-plane/scripts/sync-glossary.ts` valida que toda entrada da doc tem entrada
no `.ts` e vice-versa. Roda em CI.

### 2.4 — Busca
Input com fuzzy search (Fuse.js) sobre `term` + `short`. Resultados destacam match.

---

## 3. F.3 — "Por que isso aconteceu?"

### 3.1 — Onde aparece
Em **todo node de timeline com status 🟡/🔴** ([06-screen-lead-timeline.md](./06-screen-lead-timeline.md)),
em **todo `dispatch_attempts` com status falha/skip** ([05-screen-integration-health.md](./05-screen-integration-health.md)),
e em **todo erro/empty state** com causa diagnosticável.

Sempre como link inline `[Por que isso aconteceu?]` ou ícone `?` ao lado do erro.

### 3.2 — Conteúdo
Painel lateral (`<Sheet>`) com seções fixas:

```
┌─ Por que isso aconteceu? ───────────────── [×] ┐
│                                                │
│ ⚠️ <título humanizado do erro>                 │
│                                                │
│ ▾ Causa provável                              │
│   <explicação acessível>                       │
│                                                │
│ ▾ Como diagnosticar                           │
│   1. <passo 1>                                 │
│   2. <passo 2>                                 │
│                                                │
│ ▾ Como resolver                               │
│   • <opção 1>                                  │
│   • <opção 2>                                  │
│                                                │
│ ▾ Quando isso é normal                        │
│   <casos onde o erro não é problema>           │
│                                                │
│ Saber mais:                                    │
│   • [Documentação técnica ↗]                   │
│   • [Termos relacionados no glossário]         │
└────────────────────────────────────────────────┘
```

### 3.3 — Fonte de conteúdo

Endpoint: `GET /v1/help/skip-reason/:reason` retorna conteúdo estruturado.

Backend lê de arquivo seedado: `apps/edge/src/lib/help-content/skip-reasons.json` —
**uma entrada por `skip_reason` ou `error_code`** definido em
[11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md). CI valida cobertura
(toda chave do copy deck tem entrada de help).

### 3.4 — Exemplo: `gclid_not_found`

```json
{
  "key": "gclid_not_found",
  "title": "gclid não encontrado",
  "probableCause": "O Google Ads precisa de um identificador do clique (gclid) para registrar a conversão. Esse lead não veio de um clique no Google Ads — ou o gclid não foi capturado pelo tracker.",
  "howToDiagnose": [
    "Verifique a aba Atribuição deste lead — gclid deveria estar presente",
    "Confirme que o tracker.js captura URL params no load da página",
    "Confira se o link de campanha do Google Ads inclui gclid auto-tagging ativado"
  ],
  "howToFix": [
    "Se o lead não veio de Google Ads, é normal — esse dispatcher nem deveria ter rodado",
    "Se veio de Google Ads, ativar auto-tagging em ads.google.com → Configuração → Auto-tagging",
    "Se já está ativo, revisar instalação do tracker.js"
  ],
  "whenIsNormal": "Quando o lead chega por Meta, organic, direct ou outros canais que não são Google Ads.",
  "externalDocs": [
    { "label": "Google Ads auto-tagging", "url": "https://support.google.com/google-ads/answer/3095550" }
  ],
  "relatedTerms": ["gclid", "auto_tagging", "conversion_action"]
}
```

---

## 4. Princípios de redação

- **PT-BR**, mesmo tom do [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md)
- Não culpar usuário ("não foi possível X" > "você fez Y errado")
- Listas curtas; cada item ≤ 1 frase
- Sempre incluir **"Quando isso é normal"** — evita alarme falso
- Linkar para glossário, não inline-explicar termo se já está lá

---

## 5. Componentes shadcn

- `<Tooltip>` para F.1
- `<Sheet>` para F.3
- `<Command>` (cmdk) ou `<Input>` + Fuse.js para busca em F.2
- `<Accordion>` para "Causa provável / Como diagnosticar / Como resolver"
- `<Badge>` para tags em entradas do glossário

---

## 6. AUTHZ

Todos os 3 elementos são **universais** (todos os roles autenticados acessam).

Conteúdo é o mesmo para todos os roles — não há "ajuda só para OPERATOR".
Se um role não pode executar a ação sugerida (ex.: rotacionar token), o link aparece
desabilitado com tooltip "Apenas Operator/Admin".

---

## 7. A11y

- Tooltip tem `role="tooltip"`, `id` referenciado por `aria-describedby` no input
- `<Sheet>` (F.3) tem foco trap, fecha em Escape, retorna foco ao trigger
- Glossário busca tem `aria-live="polite"` anunciando "X resultados"
- Jump links A-Z navegáveis por teclado, `aria-label="Pular para letra A"`

---

## 8. Manutenção (CI lint rules)

Três validações em CI:

1. **Tooltip → glossário**: todo `<HelpTooltip term="X">` em código tem `glossary['X']` definido. Se não, build falha com mensagem clara.
2. **Copy deck → help content**: toda chave em [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) tem entrada em `help-content/skip-reasons.json`.
3. **Glossário sync**: `apps/control-plane/src/lib/glossary.ts` espelha [docs/00-product/06-glossary.md](../00-product/06-glossary.md).

Auditor `globaltracker-br-auditor` reforça via grep antes de merge.

---

## 9. Test harness

- `tests/unit/control-plane/help-tooltip.test.tsx` — render com term válido/inválido
- `tests/unit/control-plane/glossary-sync.test.ts` — `.ts` vs `.md` consistente
- `tests/integration/control-plane/help-skip-reason.test.tsx` — F.3 abre painel correto
- `tests/integration/control-plane/glossary-search.test.tsx` — F.2 busca funciona
- `tests/a11y/contextual-help.test.tsx` — axe-core zero violations

---

## 10. Referências

- [00-product/06-glossary.md](../00-product/06-glossary.md) — fonte canônica
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — mensagens humanizadas
- [09-interaction-patterns.md](./09-interaction-patterns.md) — padrões de interação
- [10-accessibility.md](./10-accessibility.md) — WCAG AA
