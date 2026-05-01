# BR-ATTRIBUTION — Regras de atribuição

## BR-ATTRIBUTION-001 — First-touch é por `(lead_id, launch_id)`, não global

### Status: Stable (ADR-015)

### Enunciado
First-touch row em `lead_attribution where touch_type='first'` é único por `(workspace_id, lead_id, launch_id)`. Lead que reaparece em outro lançamento recebe novo first-touch para esse lançamento.

### Enforcement
- Constraint unique parcial.
- `recordTouches()` faz INSERT ON CONFLICT DO NOTHING para first.

### Gherkin
```gherkin
Scenario: lead em 2 lançamentos
  Given lead L já tem first-touch em launch A
  When L é cadastrado em launch B
  Then novo first-touch criado para (L, B)
  And first-touch de (L, A) preservado intacto
```

---

## BR-ATTRIBUTION-002 — Last-touch é atualizado a cada conversão dentro do launch

### Status: Stable

### Enunciado
Last-touch em `lead_attribution where touch_type='last'` é UPSERT por `(workspace_id, lead_id, launch_id)`. Cada novo evento de conversão (`Lead`, `Purchase`) atualiza com attribution mais recente.

### Enforcement
- `recordTouches()` faz INSERT ... ON CONFLICT DO UPDATE.

### Gherkin
```gherkin
Scenario: lead clica em ad B depois de A; last-touch reflete B
  Given lead L em launch X com last-touch attribution=A em T0
  When evento de conversão chega em T+1d com attribution=B
  Then last-touch atualizado para B
  And first-touch preservado (intocado)
```

---

## BR-ATTRIBUTION-003 — `links.slug` é único globalmente no domínio do redirector

### Status: Stable

### Enunciado
Slug **DEVE** ser único em `links.slug` (constraint unique global). Operador pode usar mesmo slug em workspaces diferentes? **NÃO** — slug está em URL pública compartilhada do redirector.

### Enforcement
- Constraint `unique (slug)` (não `(workspace_id, slug)`).

### Gherkin
```gherkin
Scenario: dois workspaces tentam mesmo slug
  Given link slug='lcm-marco-2026' já existe em workspace W1
  When workspace W2 tenta criar link com mesmo slug
  Then unique violation
```

---

## BR-ATTRIBUTION-004 — Redirector registra clique async; latência < 50ms p95

### Status: Stable (INV-ATTRIBUTION-003)

### Enunciado
`/r/:slug` **DEVE** retornar 302 em ≤ 50ms p95 mesmo com queue lenta. Log de `link_clicks` é fire-and-forget — falha de log não bloqueia redirect.

### Enforcement
- Handler chama `recordLinkClick()` sem await (ou com timeout curto e fallback).
- Métricas observam latência p95.

### Gherkin
```gherkin
Scenario: KV/Queue lentos não afetam redirect
  Given queue com latência alta
  When GET /r/abc
  Then 302 retornado em < 50ms
  And clique persistido eventualmente (ou perdido com log)
```
