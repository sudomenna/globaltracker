# FLOW-01 — Registrar LP externa e instalar tracking

## Gatilho
MARKETER cria lançamento e quer instalar tracking em LP externa (Modo B — snippet).

## Atores
PERSONA-MARKETER, PERSONA-OPERATOR (eventual help).

## UC envolvidos
UC-001 (planejamento.md Seção 27).

## SCREEN-* relacionados
SCREEN-launch-list, SCREEN-launch-detail, SCREEN-page-registration (Fase 4).

## MOD-* atravessados
`MOD-WORKSPACE`, `MOD-LAUNCH`, `MOD-PAGE`, `MOD-AUDIT`.

## CONTRACT-* envolvidos
`CONTRACT-api-config-v1`, `CONTRACT-api-events-v1`.

## BRs aplicadas
BR-RBAC-001, BR-RBAC-006 (audit em mutações), BR-EVENT-005.

## Fluxo principal

1. MARKETER autenticado em workspace W cria Launch L com `public_id='lcm-marco-2026'`, status=`draft`.
2. MARKETER preenche tracking config (Pixel ID + policy) → status passa a `configuring`.
3. MARKETER cria Page P com `integration_mode='b_snippet'`, `role='capture'`, `allowed_domains=['lp.cliente.com']`, `event_config` (PageView on load + Lead on form_submit).
4. Sistema gera `page_token` (PageToken status=`active`) — token claro retornado **uma única vez** + audit log entry.
5. MARKETER copia snippet HTML pronto (com `data-site-token=pk_live_...`, `data-launch-public-id=lcm-marco-2026`, `data-page-public-id=captura-v3`).
6. OPERATOR (ou MARKETER técnico) instala snippet no `<head>` da LP.
7. Visitante carrega LP → `tracker.js` chama `GET /v1/config/lcm-marco-2026/captura-v3` com `X-Funil-Site: pk_live_...`.
8. Edge valida token (active), valida `Origin: https://lp.cliente.com` contra `allowed_domains`, retorna `event_config` cacheable.
9. Tracker dispara PageView via `POST /v1/events`.
10. Edge persiste em `raw_events`, retorna 202.
11. MARKETER vê em dashboard "Eventos recebidos" subir.
12. Launch passa para status=`live` quando MARKETER promove.

## Fluxos alternativos

### A1 — Token inválido / domínio não permitido

7'. Tracker manda request com domínio errado (ex.: tester instalando snippet em `staging.cliente.com` sem add domain):
   - Edge retorna 403 `origin_not_allowed`.
   - Tracker degrada silenciosamente (INV-TRACKER-007).
   - Métrica `config_origin_rejected_total` incrementa.
   - MARKETER vê em dashboard técnico que LP X está rejeitando.

### A2 — Page token rotacionado durante operação

5'. MARKETER ou OPERATOR rotaciona token (ADR-023):
   - Token antigo → `rotating` por 14 dias (configurável).
   - Novo token `active` emitido.
   - LP em produção continua usando token antigo até MARKETER atualizar snippet.
   - Métrica `legacy_token_in_use` registra ocorrências.
   - Após 14 dias, antigo → `revoked`; LP que ainda usa antigo recebe 401 e MARKETER precisa atualizar snippet.

## Pós-condições

- Launch L em `live` (após promoção).
- Page P `active` com PageToken `active` em `page_tokens`.
- `audit_log` entries para `create launch`, `create page`, `create page_token`.
- LP externa carregando tracker e enviando eventos.

## TE-* emitidos

- TE-LAUNCH-CREATED-v1
- TE-LAUNCH-STATUS-CHANGED-v1 (draft → configuring → live)
- TE-PAGE-CREATED-v1
- TE-PAGE-TOKEN-CREATED-v1
- TE-EVENT-INGESTED-v1 (a cada PageView)

## Erros previstos

| Erro | HTTP | Origem |
|---|---|---|
| `invalid_token` | 401 | `/v1/config` ou `/v1/events` |
| `origin_not_allowed` | 403 | `/v1/config` ou `/v1/events` |
| `page_not_found` | 404 | `/v1/config` |
| `archived_launch` | 410 | Tentar ingerir após launch archived |

## Casos de teste E2E sugeridos

1. **Happy path**: MARKETER cria launch → page → install snippet → page emite PageView aceito.
2. **Origem não permitida**: tracker em domínio fora de `allowed_domains` → 403, página carrega normalmente.
3. **Token revoked**: page_token em status revoked → 401; tracker degrada silenciosamente.
4. **Token rotation overlap**: token antigo rotating; ambos active e antigo aceitos durante janela; após janela, antigo rejeita.
