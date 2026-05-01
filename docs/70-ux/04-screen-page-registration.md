# 04 — SCREEN: Page Registration & Live Snippet Status

> **Status:** Sprint 6. Implementa itens A.3 + A.4 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Tela onde MARKETER cria/edita uma `page`, vê o snippet HTML pronto para colar e
**verifica em tempo real** que o tracker está funcionando. Quando o Edge rejeita pings
da LP por motivos comuns (`origin_not_allowed`, `invalid_token`), exibir diagnóstico
contextualizado com ação inline.

## Rotas

- `/launches/:launch_public_id/pages/new` — criação
- `/launches/:launch_public_id/pages/:page_public_id` — edição/detalhe

## AUTHZ

- **Criar/editar:** OPERATOR, ADMIN, MARKETER (BR-RBAC)
- **Ver `page_token` em claro:** apenas no momento da criação ou rotação (uma vez)
- **Rotacionar token:** OPERATOR, ADMIN

---

## 1. Layout — modo criação

```
Lançamento "Maio 2026" > Pages > Nova página

┌─ Identificação ───────────────────────────────────────────┐
│ Nome:            [Captura V1________________]            │
│ Public ID:       [captura-v1________________]  ⓘ         │
└──────────────────────────────────────────────────────────┘

┌─ Domínios permitidos ────────────────────────────────────┐
│ Adicione todos os domínios onde a LP roda:               │
│   [lp.cliente.com______________________]   [Remover]    │
│   [+ Adicionar domínio]                                  │
│                                                          │
│ ⚠️ O Meta exige verificação separada destes domínios     │
│    no Business Manager. [Saber mais ↗]                   │
└──────────────────────────────────────────────────────────┘

┌─ Modo de integração ─────────────────────────────────────┐
│ ◉ Snippet (recomendado)                                  │
│   Cole um <script> no <head> da LP                       │
│ ○ Server-to-server                                       │
│   Sua LP envia eventos via API direta                    │
└──────────────────────────────────────────────────────────┘

┌─ Eventos a capturar ─────────────────────────────────────┐
│ ☑ PageView (automático ao carregar)                      │
│ ☑ Lead    (no submit do formulário)                      │
│   └ Selector do form: [#capture-form_______]  ⓘ          │
│ ☐ ViewContent                                            │
│ ☐ InitiateCheckout                                       │
└──────────────────────────────────────────────────────────┘

                          [Cancelar]   [Criar página]
```

---

## 2. Layout — pós-criação (passo de instalação)

```
✓ Página criada — captura-v1

⚠️ Importante: o token abaixo aparece apenas uma vez.
   Anote-o agora ou copie o snippet completo.

┌─ Snippet de instalação ──────────────────────────────────┐
│ Cole no <head> da landing page:                          │
│                                                          │
│ ┌────────────────────────────────────────────────────────┐│
│ │ <script                                                ││
│ │   src="https://cdn.globaltracker.com/tracker.js"       ││
│ │   data-site-token="pk_live_abc123def456..."            ││
│ │   data-launch-public-id="lcm-maio-2026"                ││
│ │   data-page-public-id="captura-v1">                    ││
│ │ </script>                                              ││
│ └────────────────────────────────────────────────────────┘│
│                                              [📋 Copiar] │
│                                                          │
│ Status de instalação:                                    │
│   ⏳ Aguardando primeiro ping... (12s elapsed)           │
│      ↓ (quando chega)                                    │
│   ✅ Tracker funcionando em lp.cliente.com               │
│      • Primeiro PageView há 3s                           │
│      • Eventos recebidos: 1                              │
│      [Ver detalhes da página →]                          │
└──────────────────────────────────────────────────────────┘
```

Polling de `GET /v1/pages/:public_id/status` a cada 5s. Timeout 5min com mensagem:
```
⏰ Não recebemos pings em 5 minutos.
   Confira se o snippet está colado corretamente.
   [Ver checklist de troubleshooting →]
```

---

## 3. Layout — modo edição (depois)

```
Lançamento "Maio 2026" > Pages > captura-v1     [Editar] [Rotacionar token]

● Saudável     Domínio: lp.cliente.com    Último ping: há 12s
                                          Eventos hoje: 423
                                          Token: active (rotaciona em 87 dias)

┌─ Diagnóstico recente ────────────────────────────────────┐
│ Últimas 24h: 423 eventos aceitos, 0 rejeitados ✓         │
└──────────────────────────────────────────────────────────┘

┌─ Configuração ───────────────────────────────────────────┐
│ [tudo o que aparecia no modo criação]                    │
└──────────────────────────────────────────────────────────┘

┌─ Snippet ────────────────────────────────────────────────┐
│ Token atual: ************pk_live  (revelar exige rotação)│
│                                                          │
│ Para reinstalar com token novo:                          │
│ [Rotacionar token →]                                     │
└──────────────────────────────────────────────────────────┘
```

Token nunca exibido em claro após criação. Para "ver" novamente, MARKETER deve rotacionar (gera token novo, antigo entra em `rotating` por 14d).

---

## 4. Diagnóstico de instalação contextualizado (A.4)

Painel de **diagnóstico recente** mostra problemas detectados nas últimas 24h:

### 4.1 — Origem rejeitada (`origin_not_allowed`)

```
⚠️ Tracker rodando em domínio não autorizado

Detectamos 47 tentativas vindas de:
  • staging.cliente.com (último: há 2min)

Como esse domínio não está na lista permitida, os eventos
foram rejeitados pela borda — a página continua funcionando
normalmente, mas nada chega no GlobalTracker.

[+ Adicionar staging.cliente.com aos permitidos]
[Ignorar (é tráfego indevido)]
```

Fonte: agregação de logs `config_origin_rejected_total` filtrado por `page_id` ([docs/10-architecture/07-observability.md](../10-architecture/07-observability.md)).

### 4.2 — Token inválido (`invalid_token`)

```
⚠️ Snippet desatualizado em produção

Detectamos 12 requisições com token rotacionado em
lp.cliente.com (último: há 5min).

Isso geralmente significa que o snippet antigo ainda está
no <head> da LP e precisa ser atualizado para o novo token.

[Ver snippet atual]   [Estender janela de rotação]
```

### 4.3 — Sem ping recente

```
⚠️ Nenhum evento recebido há 47 horas

Possíveis causas:
  • Snippet removido da LP
  • LP fora do ar
  • Bloqueio por adblocker / firewall do cliente

[Diagnosticar →]
```

Click em "Diagnosticar" abre checklist:
- [ ] LP responde com 200 em fetch direto?
- [ ] Snippet presente no `<head>` (curl + grep)?
- [ ] CDN do tracker.js acessível (`/cdn-cgi/trace`)?

---

## 5. Componentes shadcn

- `<Form>` + `<FormField>` (React Hook Form + Zod)
- `<Card>` para cada seção
- `<RadioGroup>` para modo de integração
- `<Checkbox>` para eventos
- `<Input>` + tag input para domínios (custom)
- `<CodeBlock>` com syntax highlight + botão copy (custom)
- `<HealthBadge size="sm">` ([07-component-health-badges.md](./07-component-health-badges.md))
- `<Alert>` variant="warning"/"destructive" para diagnóstico
- `<Tooltip>` em ⓘ
- `<AlertDialog>` para rotação de token (destrutiva)

---

## 6. Estados

- **Loading inicial (modo edição):** skeleton em todos os cards
- **Loading status:** spinner inline ao lado de "Aguardando primeiro ping..."
- **Sucesso (status):** transição animada de ⏳ → ✅
- **Empty (sem eventos hoje):** "Nenhum evento ainda — aguardando primeiro ping"
- **Error fetching:** "Não foi possível verificar status — tentando novamente em 5s"
- **Error criando page:** validação inline + toast com correlation id

---

## 7. Polling specifics (A.3)

Endpoint: `GET /v1/pages/:public_id/status`

Response:
```json
{
  "page_public_id": "captura-v1",
  "health_state": "healthy",            // health-badge state
  "last_ping_at": "2026-05-01T12:03:24Z" | null,
  "events_today": 423,
  "events_last_24h": 1247,
  "token_status": "active",             // active | rotating | expired | revoked
  "token_rotates_at": "2026-08-01T...",
  "recent_issues": [                    // for A.4
    {
      "type": "origin_not_allowed",
      "domain": "staging.cliente.com",
      "count": 47,
      "last_seen_at": "..."
    }
  ]
}
```

Cliente: SWR com `refreshInterval: 5000` durante "aguardando primeiro ping",
muda para `60_000` após primeiro ping bem-sucedido.

---

## 8. Endpoints consumidos

- `POST /v1/launches/:id/pages` — criar (response inclui `page_token` em claro)
- `GET /v1/launches/:id/pages/:public_id` — detalhe
- `PATCH /v1/launches/:id/pages/:public_id` — editar config
- `GET /v1/pages/:public_id/status` — A.3 polling
- `POST /v1/pages/:public_id/rotate-token` — A.2 do FLOW-01

---

## 9. A11y

- Live region (`aria-live="polite"`) anuncia mudança de status: "Tracker funcionando em lp.cliente.com"
- Snippet copy button tem `aria-label="Copiar snippet de instalação"`
- Diagnóstico em `<Alert>` com `role="alert"` quando severity ≥ warning
- Token revelado tem `aria-describedby` apontando para aviso "aparece apenas uma vez"

---

## 10. Test harness

- `tests/integration/control-plane/page-registration.test.tsx` — happy path criação
- `tests/integration/control-plane/page-status-polling.test.tsx` — polling + transição de estado
- `tests/integration/control-plane/page-diagnostics.test.tsx` — A.4 cenários origin_not_allowed e invalid_token
- E2E: "MARKETER instala tracker e vê confirmação visual" ([docs/80-roadmap/98-test-matrix-by-sprint.md](../80-roadmap/98-test-matrix-by-sprint.md))

---

## 11. Referências

- [03-screen-onboarding-wizard.md](./03-screen-onboarding-wizard.md) — passo 4-5 do wizard
- [07-component-health-badges.md](./07-component-health-badges.md) — badge usado
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — mensagens de erro
- [60-flows/01-register-lp-and-install-tracking.md](../60-flows/01-register-lp-and-install-tracking.md) — fluxo
- [20-domain/03-mod-page.md](../20-domain/03-mod-page.md) — entidade Page
- [10-architecture/07-observability.md](../10-architecture/07-observability.md) — métricas fonte
