# 02 — Information architecture

> **Status:** skeleton. Detalhamento completo na Fase 4.

## Sidebar (Control Plane)

Cada item da sidebar tem badge de saúde discreto agregado da seção (verde/amarelo/vermelho/cinza)
— ver [07-component-health-badges.md](./07-component-health-badges.md).

```
🏠 Home / Workspace overview
📦 Lançamentos                                    ●
  └ Lista
  └ Detalhe (com tabs: Pages, Links, Audiences, Eventos, Performance)
  └ Eventos ao vivo (Sprint 8)
👥 Leads                                           ●
  └ Busca
  └ Detalhe (com PII sanitizada por default)
    └ Aba Timeline (visual end-to-end por lead)
  └ Live (Sprint 8)
🎯 Audiences                                       ●
  └ Lista
  └ Builder
  └ Sync history
🔌 Integrações                                     ●
  └ Meta / Google / GA4 (credenciais + saúde + teste)
  └ Webhooks (Hotmart / Stripe / Kiwify / etc.)
📊 Analytics
  └ Link para Metabase (com SSO ideal)
❓ Ajuda
  └ Glossário
  └ Onboarding (re-entry)
🔒 Privacy                                         ●
  └ SAR / Erasure (PRIVACY+)
  └ Audit log (PRIVACY+)
  └ Retention policies
⚙️  Configurações
  └ Workspace
  └ Members
  └ API Keys
  └ Tokens (page tokens management)
```

Header global tem **badge de saúde do workspace** (B.4) com painel lateral de incidentes,
**toggle de modo teste** (Sprint 8) e banner discreto "Setup incompleto" enquanto onboarding pendente.

## Rotas

```
/                                       → home/dashboard
/onboarding                             → wizard 5 passos (Sprint 6)
/launches                               → lista
/launches/:public_id                    → detalhe (tabs); tab ativa via query param ?tab=
/launches/:public_id?tab=overview       → visão geral do lançamento (Sprint 9)
/launches/:public_id?tab=pages          → tab pages (chip de role por page) (Sprint 9)
/launches/:public_id?tab=eventos        → tab eventos ao vivo — GET /v1/events + autorefresh 10s (Sprint 9)
/launches/:public_id?tab=audiences      → tab audiences (Sprint 9)
/launches/:public_id?tab=performance    → tab performance (Sprint 9)
/launches/:public_id/pages              → tab pages (rota legada — redireciona para ?tab=pages)
/launches/:public_id/pages/new          → criação de page (Sprint 6)
/launches/:public_id/pages/:public_id   → detalhe page + snippet vivo (Sprint 6)
/launches/:public_id/links              → tab links
/launches/:public_id/audiences          → tab audiences
/launches/:public_id/events/live        → console de eventos ao vivo (Sprint 8)
/leads                                  → busca
/leads/:public_id                       → detalhe (default tab=timeline) (Sprint 6)
/leads/:public_id?tab=timeline          → aba Timeline visual
/leads/live                             → console live cross-launch (Sprint 8)
/audiences                              → lista global (cross-launch)
/audiences/builder                      → builder visual
/integrations                           → lista de integrações + saúde (Sprint 6)
/integrations/meta                      → setup Meta CAPI + saúde + teste (Sprint 6)
/integrations/ga4                       → setup GA4 MP + saúde + teste (Sprint 6)
/integrations/google-ads                → setup Google Ads + saúde + teste (Sprint 6)
/integrations/webhooks/:provider        → setup webhook
/help/glossary                          → glossário in-app (Sprint 6)
/privacy/sar                            → form de SAR
/privacy/audit                          → audit log viewer
/settings/workspace                     → workspace config
/settings/members                       → CRUD members
/settings/api-keys                      → CRUD api keys
/settings/onboarding                    → re-entry do wizard (Sprint 6)
```

## Command palette (Fase 4)

`Cmd+K` / `Ctrl+K` para busca rápida:
- Lançamentos por nome.
- Leads por email/phone (apenas para PRIVACY/OWNER — outros papéis veem por public_id).
- Atalhos: "Criar lançamento", "Rotacionar token de página X".

## Breadcrumbs

`Workspace > Lançamentos > Março 2026 > Pages > Captura V3`. Sempre clicáveis.

## Notificações (Fase 4)

- Toaster shadcn para confirmações imediatas.
- Inbox (Fase 5+) para alertas async (DLQ size, page token rotation lembrete).
