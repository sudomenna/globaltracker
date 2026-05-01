# 06 — SCREEN: Lead Detail — Timeline

> **Status:** Sprint 6. Implementa itens C.1 + C.2 + C.3 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Tela de detalhe do lead com **aba Timeline** mostrando linha do tempo visual de tudo
que aconteceu com aquele lead — eventos recebidos, identidade resolvida, dispatches
para destinos externos com status, falhas humanizadas e payloads sanitizados.

Permite:
- MARKETER entender visualmente o que aconteceu sem ler logs
- OPERATOR diagnosticar dispatches com falha
- ADMIN re-dispatchar jobs com `dead_letter`/`failed`

## Rota

`/leads/:lead_public_id` (aba `?tab=timeline`, default)

Outras abas (não cobertas aqui): Identidade, Atribuição, Consentimento, Eventos (lista flat).

## AUTHZ

| Elemento | MARKETER | OPERATOR | ADMIN | PRIVACY |
|---|---|---|---|---|
| Ver timeline | ✓ (PII mascarada) | ✓ (PII hash) | ✓ (PII hash) | ✓ (decrypt c/ audit) |
| Expandir payload | ✓ (sanitizado) | ✓ (full) | ✓ (full) | ✓ (decrypt c/ audit) |
| Ver campos técnicos | ✗ | ✓ | ✓ | ✗ |
| Re-dispatch (C.3) | ✗ | ✓ | ✓ | ✗ |

---

## 1. Layout

```
Leads > ld_abc123                         [Identidade] [Atribuição] [Consentimento] [Timeline]

┌─ Resumo ─────────────────────────────────────────────────┐
│ Lead ld_abc123    ● Ativo    Criado há 2h                │
│ Stage: registered    Eventos: 5    Dispatches: 12        │
└──────────────────────────────────────────────────────────┘

┌─ Filtros ────────────────────────────────────────────────┐
│ [✓ Eventos] [✓ Identidade] [✓ Atribuição] [✓ Dispatch]   │
│ [Período: tudo ▾]   [Status: tudo ▾]                     │
└──────────────────────────────────────────────────────────┘

┌─ Timeline ───────────────────────────────────────────────┐
│                                                          │
│  🟢 12:03:21  Lead capturado via formulário              │
│      lp.cliente.com / captura-v3                         │
│      email: a***@gmail.com   telefone: ***-9876          │
│      consent: ad_user_data ✓  analytics ✓                │
│      [▾ Ver payload]                                     │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  🟢 12:03:23  Lead resolvido (novo)                      │
│      Aliases criados: email_hash, phone_hash             │
│      First-touch atribuído:                              │
│        utm_source=meta utm_campaign=lcm-cold-v3          │
│      [▾ Detalhes]                                        │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  🟢 12:03:24  Despachado para Meta CAPI                  │
│      ✓ Entregue em 340ms                                 │
│      event_id: evt_abc123                                │
│      Match com Pixel browser: ✓                          │
│      [Ver no Meta Events Manager ↗] [▾ Payload]          │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  🟡 12:03:24  Despachado para GA4 MP                     │
│      ⚠ Entregue com aviso (220ms)                        │
│      Sem GA4 client_id no cookie — usado mintado         │
│      [Ver no GA4 DebugView ↗] [▾ Payload]                │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  🔴 12:03:25  Despachado para Google Ads (failed)        │
│      ✗ gclid não encontrado                              │
│      [Por que isso aconteceu?] [Tentar novamente]        │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  ⚪ 12:04:01  Aguardando: Purchase                       │
│      Conversão configurada para esse funil               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Linha do tempo vertical com indicadores de status à esquerda. Cada item expansível.

---

## 2. Tipos de itens (canônicos)

Mapeamento dos eventos de domínio que viram nodes da timeline:

| Origem | Node label (MARKETER) | Status | Ícone |
|---|---|---|---|
| `events` row inserida | "Lead capturado" / "PageView" / "Purchase" / etc. | sempre 🟢 | depende do `event_name` |
| Lead novo criado | "Lead resolvido (novo)" | 🟢 | UserPlus |
| Lead reusado | "Lead reconhecido" | 🟢 | UserCheck |
| Lead merge (BR-IDENTITY-003) | "Lead unificado com outro" | 🟢 | Users |
| `lead_attribution` first | "First-touch atribuído" | 🟢 | Flag |
| `lead_attribution` last update | "Last-touch atualizado" | 🟢 | RotateCw |
| `lead_stages` change | "Stage alterado: X → Y" | 🟢 | TrendingUp |
| `lead_consents` row | "Consent registrado" | 🟢 | Shield |
| `dispatch_jobs` succeeded | "Despachado para [destino]" | 🟢 | CheckCircle |
| `dispatch_jobs` succeeded com warning | "Despachado com aviso" | 🟡 | AlertCircle |
| `dispatch_jobs` skipped | "Não despachado: [motivo]" | 🟡 | SlashCircle |
| `dispatch_jobs` failed (retrying) | "Falhou — vai tentar novamente" | 🟡 | RotateCw |
| `dispatch_jobs` failed (final) | "Falhou definitivamente" | 🔴 | XCircle |
| `dispatch_jobs` dead_letter | "Falhou e parou de tentar" | 🔴 | OctagonX |
| `dispatch_jobs` pending | "Aguardando despacho" | ⚪ | Clock |
| SAR/erasure aplicado | "Dados anonimizados (SAR)" | ⚫ | EyeOff |

Build a partir de:
- `events` join `dispatch_jobs` join `dispatch_attempts`
- `lead_aliases`, `lead_attribution`, `lead_stages`, `lead_consents`, `lead_merges`
- `audit_log` para SAR/erasure events

Endpoint: `GET /v1/leads/:public_id/timeline?since=...&filters=...`.

---

## 3. Expandir payload (drill-down por role)

Click em "▾ Ver payload" expande inline:

### Para MARKETER (sanitizado)
```
Payload enviado ao Meta CAPI:
  event_name: Lead
  event_time: 2026-05-01 12:03:24
  user_data:
    em: a***@gmail.com (hash)
    ph: ***-9876 (hash)
    fbc: presente
    fbp: presente
  custom_data:
    value: 0
    currency: BRL

Resposta:
  Status: ✓ Recebido (events_received: 1)
  Match Quality: 7.8/10
```

### Para OPERATOR/ADMIN (full)
```
Request:
  POST https://graph.facebook.com/v20.0/<pixel>/events
  Headers: { Authorization: Bearer ******** }
  Body: { ... payload completo com hashes ... }

Response (200):
  { events_received: 1, fbtrace_id: '...', messages: [] }

Metadata:
  attempt_number: 1
  latency_ms: 340
  idempotency_key: sha256(workspace_id|event_id|meta_capi|...)
  request_id: 7c2a... (correlation com logs)
```

### Para PRIVACY (decrypt PII)
Botão extra `[Ver PII em claro]` — gera `audit_log` entry com `action='decrypt_pii'`,
`actor`, `reason` (modal pede justificativa) — BR-PRIVACY.

---

## 4. Re-dispatch (C.3)

Em job com `status='dead_letter'` ou `'failed'` (final), botão **"Tentar novamente"**:

```
┌─ Confirmar re-dispatch ──────────────────────────────────┐
│ Re-enviar este evento para Meta CAPI?                    │
│                                                          │
│ Evento: Lead (evt_abc123)                                │
│ Falha original: invalid_pixel_id (há 2h)                 │
│                                                          │
│ Antes de tentar:                                         │
│   ☐ Confirmo que verifiquei a configuração do Pixel      │
│                                                          │
│ Justificativa (audit log):                               │
│ [_______________________________________________]        │
│                                                          │
│             [Cancelar]   [Confirmar e tentar novamente]  │
└──────────────────────────────────────────────────────────┘
```

Backend chama `requeueDeadLetter(job_id)` (BR-DISPATCH-005), reseta `attempt_count=0`,
`status='pending'`, registra `audit_log` com `action='reprocess_dlq'`, `actor`, `reason`.

Apenas OPERATOR/ADMIN. MARKETER vê botão desabilitado com tooltip "Apenas Operator/Admin".

---

## 5. Inline help: "Por que isso aconteceu?"

Em qualquer node 🔴/🟡, link inline abre painel lateral:

```
┌─ Por que isso aconteceu? ────────────────────────────────┐
│                                                          │
│ Falha: gclid não encontrado                              │
│                                                          │
│ O Google Ads precisa de um identificador do clique       │
│ (gclid) para registrar a conversão. Esse lead não veio   │
│ de um clique no Google Ads — ou o gclid não foi          │
│ capturado pelo tracker.                                  │
│                                                          │
│ Como diagnosticar:                                       │
│   1. Verifique a aba [Atribuição] deste lead — gclid     │
│      deveria estar presente                              │
│   2. Confirme que o tracker.js captura URL params no     │
│      load da página                                      │
│                                                          │
│ Como resolver:                                           │
│   • Se o lead não veio de Google Ads, é normal — esse    │
│     dispatcher nem deveria ter rodado                    │
│   • Se veio, revisar instalação do tracker e o redirect  │
│                                                          │
│ Saber mais: [BR-DISPATCH-* ↗] [docs/40-integrations ↗]   │
└──────────────────────────────────────────────────────────┘
```

Conteúdo derivado do [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md).

---

## 6. Componentes shadcn

- `<Tabs>` para abas do lead (Identidade / Atribuição / Consentimento / Timeline)
- Custom `<Timeline>` (Vertical Stepper) — sem componente nativo no shadcn, usar pattern com `<div>` + bordas + ícones lucide
- `<Collapsible>` para expandir payload
- `<Sheet>` para "Por que isso aconteceu?"
- `<AlertDialog>` para confirmar re-dispatch (destrutiva)
- `<Badge>` para status colorido em cada node
- `<Button variant="ghost">` para deep-links
- `<DropdownMenu>` para filtros

---

## 7. Performance

- Timeline carrega últimos 50 nodes (cursor-based pagination) — botão "Carregar mais antigos"
- Backend pré-monta nodes em endpoint dedicado (não calcular no client)
- Lead com > 500 nodes (caso raro) tem aviso: "Mostrando apenas dispatches deste mês — [Ver tudo]"
- Sem realtime (Sprint 6) — refresh manual via botão; Sprint 8 conecta a Live Console

---

## 8. Estados

- **Loading:** skeleton de 5 nodes
- **Empty:** "Esse lead ainda não tem atividade registrada"
- **Error:** "Não foi possível carregar a timeline. [Tentar novamente]"
- **Lead arquivado/SAR:** banner topo "Este lead foi anonimizado por SAR — dados removidos"

---

## 9. Endpoints consumidos

- `GET /v1/leads/:public_id` — resumo
- `GET /v1/leads/:public_id/timeline?cursor=...&filters=...&limit=50` — nodes
- `POST /v1/dispatch-jobs/:id/replay` — re-dispatch (audit log)
- `POST /v1/leads/:public_id/decrypt-pii` — PRIVACY apenas (audit log)
- `GET /v1/help/skip-reason/:reason` — conteúdo "Por que isso aconteceu?"

---

## 10. A11y

- Timeline navegável por teclado (Tab move entre nodes; Enter/Space expande payload)
- Status de cada node anunciado: `aria-label="Despachado para Meta CAPI: sucesso"`
- Linha visual decorativa marcada `aria-hidden="true"`
- Live region para feedback de re-dispatch ("Re-dispatch enfileirado")
- Cores nunca isoladas — todo status ✓/⚠/✗ tem ícone + label

---

## 11. Test harness

- `tests/integration/control-plane/lead-timeline.test.tsx` — render + filtros
- `tests/integration/control-plane/lead-timeline-payload-authz.test.tsx` — sanitização por role
- `tests/integration/control-plane/lead-timeline-redispatch.test.tsx` — fluxo C.3 + audit log
- `tests/integration/control-plane/lead-timeline-pii-decrypt.test.tsx` — PRIVACY + audit log
- E2E: "Lead falha em Meta → MARKETER vê reason humanizada na timeline" ([docs/80-roadmap/98-test-matrix-by-sprint.md](../80-roadmap/98-test-matrix-by-sprint.md))

---

## 12. Referências

- [02-information-architecture.md](./02-information-architecture.md) — rota
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — mensagens humanizadas
- [05-screen-integration-health.md](./05-screen-integration-health.md) — drill-down complementar
- [20-domain/04-mod-identity.md](../20-domain/04-mod-identity.md) — Lead, aliases, merges
- [20-domain/05-mod-event.md](../20-domain/05-mod-event.md) — events
- [20-domain/08-mod-dispatch.md](../20-domain/08-mod-dispatch.md) — dispatch_jobs/attempts
- [50-business-rules/BR-DISPATCH.md](../50-business-rules/BR-DISPATCH.md) — re-dispatch / DLQ
- [50-business-rules/BR-PRIVACY.md](../50-business-rules/BR-PRIVACY.md) — decrypt PII audit
- [30-contracts/03-timeline-event-catalog.md](../30-contracts/03-timeline-event-catalog.md) — TE-* canônicos
