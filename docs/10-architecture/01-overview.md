# 01 — Visão geral arquitetural

## Camadas

GlobalTracker é organizado em 3 camadas independentes (Seção 6 do `planejamento.md` v3.0):

```mermaid
flowchart TB
    subgraph CP[Control Plane — Fase 4]
        W[Launch Wizard]
        PR[Page Registration]
        LG[Link Generator]
        AD[Audience Definitions]
        DBUI[Dashboard custom — Fase 6]
    end

    subgraph ORC[Orchestrator — Fase 5]
        JP[deploy_pages]
        JT[setup_tracking]
        JL[generate_links]
        JA[setup_audiences]
        JM[provision_meta_google]
    end

    subgraph RT[Runtime — Fase 1-3]
        TR[tracker.js]
        EG[Edge Gateway / Hono]
        RAW[(raw_events)]
        IP[Ingestion Processor]
        Q[CF Queues]
        DJ[Dispatch Workers]
        DB[(Postgres / Supabase)]
        MB[Metabase]
        WH[Webhook Adapters]
        RD[Redirector]
    end

    CP --> ORC
    ORC --> RT
    TR --> EG
    WH --> EG
    RD --> EG
    EG --> RAW
    RAW --> IP
    IP --> DB
    IP --> DJ
    DJ --> Q
    Q --> META[Meta CAPI]
    Q --> GOOGLE[Google Ads / GA4]
    Q --> AUD[Audience APIs]
    DB --> MB
    DB --> DBUI
```

## Princípio: Runtime independente

Runtime é a única camada necessária para gerar valor. Control Plane e Orchestrator são aceleradores — sistema funciona sem eles (operador usa YAML manual + secret manager).

## Fluxo de request (`/v1/events`)

```mermaid
sequenceDiagram
    participant B as Browser
    participant E as Edge Worker
    participant KV as CF KV
    participant DB as Postgres
    participant Q as CF Queue
    participant W as Worker async

    B->>E: POST /v1/events
    E->>E: Token + CORS + Zod + clamp event_time
    E->>KV: Replay protection check
    alt já visto
        E-->>B: 202 duplicate_accepted
    else novo
        E->>DB: INSERT raw_events
        E->>KV: mark seen
        E->>Q: enqueue raw_event_id
        E-->>B: 202 accepted
        Q->>W: consume async
        W->>DB: resolve lead, normalize, create dispatch_jobs
    end
```

## Componentes

| Componente | Tecnologia | Fase |
|---|---|---|
| Edge Gateway | Cloudflare Workers + Hono | 1 |
| Ingestion Processor | CF Queue consumer | 1-2 |
| Database | Postgres via Supabase + Drizzle ORM + Hyperdrive | 1 |
| Cache / KV | Cloudflare KV | 1 |
| Queues | Cloudflare Queues (at-least-once) | 1 |
| Crons | CF Cron Triggers | 3 |
| Tracker | TS vanilla < 15KB gz | 2 |
| LP Templates | Astro + Cloudflare Pages | 5 |
| Control Plane | Next.js 15 App Router + shadcn | 4 |
| Orchestrator | Trigger.dev | 5 |
| Analytics | Metabase em Postgres views | 3 |
| Dashboard custom | Next.js + Supabase Realtime | 6 |

## Multi-tenancy

`workspace_id` em todas as tabelas + RLS no Postgres + crypto key derivada por workspace via HKDF. Detalhe em [`02-stack.md`](02-stack.md) e [`03-data-layer.md`](03-data-layer.md).

## Privacy by design

- PII em 3 categorias: hash, encrypted, transient (`10-product/06-glossary.md`).
- `pii_key_version` por registro permite rotação.
- Logs sanitizados centralmente.
- SAR via endpoint admin.

Decisões fundamentais em [`../90-meta/04-decision-log.md`](../90-meta/04-decision-log.md).
