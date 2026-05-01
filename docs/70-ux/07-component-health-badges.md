# 07 — Componente reutilizável: Health Badges

> **Status:** Sprint 6. Implementa itens B.1, B.3, B.4 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Componente único e estados consistentes para indicação visual de saúde (verde/amarelo/vermelho/cinza)
em três contextos:
- **Sidebar** (B.1): badge agregado por seção
- **Page detail** (B.3): badge por landing page
- **Workspace header** (B.4): badge agregado do workspace

Centralizar lógica + aparência evita drift entre contextos.

---

## 1. Estados canônicos

| Estado | Cor (token) | Ícone | Aria-label | Significado |
|---|---|---|---|---|
| `healthy` | `--color-success` (verde) | `CheckCircle` | "Saudável" | 0 incidentes ativos |
| `degraded` | `--color-warning` (amarelo) | `AlertTriangle` | "Atenção" | 1+ incidentes não-críticos (failure rate < 5%, token expirando, ping antigo) |
| `unhealthy` | `--color-danger` (vermelho) | `XCircle` | "Crítico" | 1+ incidentes críticos (DLQ > 0, failure rate ≥ 5%, sem ping > 24h, token revogado) |
| `unknown` | `--color-muted` (cinza) | `HelpCircle` | "Sem dados" | Sem informação suficiente (workspace novo, integration não configurada) |
| `loading` | skeleton | — | "Carregando" | Fetch in-flight (≥ 200ms) |

A11y: estados nunca dependem **só** de cor. Sempre cor + ícone + aria-label (WCAG AA — [10-accessibility.md](./10-accessibility.md)).

---

## 2. API do componente

```tsx
// apps/control-plane/src/components/health-badge.tsx

type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'loading';

interface HealthBadgeProps {
  state: HealthState;
  size?: 'xs' | 'sm' | 'md';        // xs: dot-only para sidebar; sm: dot+label; md: card
  label?: string;                    // override do aria-label default
  incidentCount?: number;            // mostra "(3)" ao lado quando > 0
  tooltip?: string;                  // hover/focus mostra explicação
  onClick?: () => void;              // se interativo, vira <button>
}

<HealthBadge state="degraded" size="xs" tooltip="2 incidentes ativos" />
```

Variantes:
- **`size="xs"`**: dot 8px, sem label (uso em sidebar)
- **`size="sm"`**: dot 10px + label inline (uso em listas, cards)
- **`size="md"`**: card completo com título + métricas resumidas (uso em workspace header expandido)

---

## 3. Uso em B.1 — Sidebar

```tsx
// apps/control-plane/src/components/sidebar-nav.tsx
<NavItem href="/integrations" icon={Plug} label="Integrações">
  <HealthBadge
    state={integrationsHealth.state}
    size="xs"
    tooltip={integrationsHealth.summary}
  />
</NavItem>
```

Fonte de dados: `GET /v1/health/integrations` (polling 60s, SWR).

Regra de agregação:
- Algum destino com DLQ > 0 ou failure rate ≥ 5% → `unhealthy`
- Algum destino com failure rate entre 1% e 5% → `degraded`
- Tudo OK → `healthy`
- Workspace sem integrações configuradas → `unknown`

Mesma lógica para outras seções: `Lançamentos`, `Audiences` (sync health), `Privacy` (SAR pendente, `audit_log_failures_total` > 0).

---

## 4. Uso em B.3 — Page detail

```tsx
// apps/control-plane/src/screens/page-detail.tsx
<PageHeader title={page.public_id}>
  <HealthBadge
    state={pageHealth.state}
    size="sm"
    label={pageHealth.label}      // "Saudável" / "Sem pings em 24h" / etc.
  />
</PageHeader>

<MetricsGrid>
  <Metric label="Domínio" value={page.allowed_domains.join(', ')} />
  <Metric label="Último ping" value={relativeTime(pageHealth.lastPingAt)} />
  <Metric label="Eventos hoje" value={pageHealth.eventsToday} />
  <Metric label="Token" value={tokenStatusLabel(page.token)} />
</MetricsGrid>
```

Fonte: `GET /v1/pages/:public_id/status`.

Estados de page (calculados server-side):
- `healthy`: ping < 5min, token active, 0 origin_rejected na última hora
- `degraded`: ping entre 5min e 24h, OU token rotating, OU token expira em < 7d
- `unhealthy`: sem ping > 24h, OU token revoked, OU origin_rejected > 0 na última hora
- `unknown`: page criada mas nunca recebeu ping (estado inicial)

---

## 5. Uso em B.4 — Workspace header

```tsx
// apps/control-plane/src/components/app-header.tsx
<Header>
  <WorkspaceSwitcher />
  <HealthBadge
    state={workspaceHealth.state}
    size="sm"
    label={workspaceHealth.summary}    // "Tudo OK" / "2 incidentes" / "Crítico"
    incidentCount={workspaceHealth.incidents.length}
    onClick={() => openIncidentsPanel()}
  />
  <NotificationBell />
</Header>
```

Painel lateral de incidentes (lazy-loaded ao clicar):
```
┌──────────────────────────────────────────┐
│ Incidentes ativos (2)             [×]    │
├──────────────────────────────────────────┤
│ ● Meta CAPI: 7 falhas em 24h             │
│   [Investigar →]                         │
│                                          │
│ ● Page captura-v3: sem ping há 3h        │
│   [Diagnosticar →]                       │
└──────────────────────────────────────────┘
```

Fonte: `GET /v1/health/workspace` (agrega integrations + pages + audiences + privacy).

---

## 6. Estados visuais

### Dot only (xs)
```
●  (8px, cor do estado)
```

### Dot + label (sm)
```
● Saudável                    (default)
● 2 incidentes      [3]       (com counter)
```

### Card (md)
```
┌────────────────────────────┐
│ ● Tudo OK                  │
│ Última verificação há 12s  │
└────────────────────────────┘
```

### Loading (skeleton)
```
░░░░  (animated shimmer)
```

---

## 7. Performance

- Cache cliente (SWR) com `refreshInterval: 60_000`.
- Endpoints retornam `Cache-Control: max-age=30` para deduplicação entre tabs.
- Falha no fetch → mostra estado `unknown` com tooltip "Não foi possível verificar saúde — última verificação às HH:MM".
- Endpoints health são derivados de `dispatch_health_view` (materialized view existente — [docs/10-architecture/07-observability.md](../10-architecture/07-observability.md)).

---

## 8. AUTHZ

Visibilidade do badge é universal (todos os roles autenticados veem).

Drill-down (B.4 incidentes panel) restringe ações por role:
- **MARKETER**: vê lista, pode clicar em "Investigar"
- **OPERATOR/ADMIN**: vê + pode triggar `requeueDeadLetter` etc.
- **PRIVACY**: vê apenas incidentes não-PII

---

## 9. Test harness

- `tests/unit/control-plane/health-badge.test.tsx` — todos os estados renderizam corretamente
- `tests/unit/control-plane/health-aggregation.test.ts` — regra de agregação (degraded/unhealthy thresholds)
- `tests/integration/control-plane/sidebar-health.test.tsx` — polling, fail-soft em fetch error
- `tests/a11y/health-badge.test.tsx` — axe-core: zero violations

---

## 10. Referências

- [09-interaction-patterns.md](./09-interaction-patterns.md) — padrões loading/error
- [10-accessibility.md](./10-accessibility.md) — WCAG AA
- [01-design-system-tokens.md](./01-design-system-tokens.md) — tokens de cor
- [10-architecture/07-observability.md](../10-architecture/07-observability.md) — `dispatch_health_view`
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — copy para descrição de incidentes
