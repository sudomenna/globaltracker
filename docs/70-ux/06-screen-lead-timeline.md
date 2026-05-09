# 06 — SCREEN: Lead Detail — Observability

> **Status:** Sprint 17 (atualizado). Implementa "Lead Detail Observability" — header agregado + 6 abas com deep-link por URL.
>
> Versão original (Sprint 6) cobria itens C.1 + C.2 + C.3. Esta versão substitui a spec de layout e endpoints consumidos, mantendo a lógica de AUTHZ, re-dispatch (C.3) e inline help.

## Propósito

Tela de detalhe do lead com **header de observability agregado** e **6 abas** para drill-down em cada dimensão do lead — jornada, eventos, despachos, atribuição, consentimento e identidade.

Permite:
- MARKETER entender visualmente o que aconteceu sem ler logs
- OPERATOR diagnosticar dispatches com falha
- ADMIN re-dispatchar jobs com `dead_letter`/`failed`

## Rota

`/leads/:lead_public_id` — aba ativa via query param `?tab=<nome>` (default: `jornada`).

Tabs disponíveis: `jornada`, `eventos`, `despachos`, `atribuicao`, `consent`, `identidade`.

## AUTHZ

| Elemento | MARKETER | OPERATOR | ADMIN | PRIVACY |
|---|---|---|---|---|
| Ver header + jornada | ✓ (PII mascarada) | ✓ | ✓ | ✓ |
| Expandir payload de evento | ✓ (sanitizado) | ✓ (full) | ✓ (full) | ✓ (decrypt c/ audit) |
| Ver campos técnicos (identity tab) | ✗ | ✓ | ✓ | ✗ |
| Re-dispatch (C.3) | ✗ | ✓ | ✓ | ✗ |
| Ver PII em claro (consent + identity) | ✗ | ✗ | ✓ | ✓ (c/ audit) |

---

## 1. Layout

```
Leads > ld_abc123

┌─ LeadSummaryHeader ──────────────────────────────────────┐
│                                                          │
│  Jornada:  [contato] → [lead] → [purchased_workshop]     │
│                                                          │
│  [5 eventos]  [12 ok]  [Comprou ✓]  [Ativo há 2min]     │
│                                                          │
│  Tags: [icp] [alta-intencao]                             │
│                                                          │
│  Atribuição: utm_source=meta | utm_campaign=lcm-cold-v3  │
│  Consent:  analytics ✓  marketing ✓  ad_user_data ✓      │
│            ad_personalization ✓  customer_match ✓        │
│                                                          │
└──────────────────────────────────────────────────────────┘

[Jornada] [Eventos] [Despachos] [Atribuição] [Consent] [Identidade]

(conteúdo da aba selecionada)
```

---

## 2. LeadSummaryHeader

Server component (`lead-summary-header.tsx`). Renderizado no `page.tsx` antes das Tabs, via fetch paralelo ao `GET /v1/leads/:public_id/summary`.

Seções:

### 2.1 Jornada Strip
Sequência de stages com arrows: `[stage_1] → [stage_2] → ... → [stage_atual]`. Cada stage é um chip com tooltip mostrando `at` (ISO → relativo). Fonte: `stages_journey`.

### 2.2 Mini-cards (4)
| Card | Fonte |
|---|---|
| Eventos | `metrics.events_total` |
| Despachos OK | `metrics.dispatches_ok` |
| Comprado | `metrics.purchase_total_brl > 0` (ícone ✓/—, valor em BRL) |
| Última atividade | `metrics.last_activity_at` (relativo, ex: "há 2min") |

### 2.3 Tags
Chips das `tags[]` do lead (`TagBadge`). Tooltip com `set_by` + `set_at`.

### 2.4 Atribuição (resumo)
Primeira linha: `utm_source` / `utm_medium` / `utm_campaign` do `first_touch`. Click_ids (fbclid/gclid) quando presentes. Link para aba Atribuição completa.

### 2.5 Consentimento (resumo)
Ícones das 5 finalidades: analytics, marketing, ad_user_data, ad_personalization, customer_match. Link para aba Consent.

---

## 3. Aba Jornada (default)

Implementada em `journey-tab.tsx`. Usa `use-timeline.ts` (SWR Infinite hook compartilhado).

### Layout
Timeline vertical com:
- `StageDivider` — barra horizontal com label do stage quando muda (derivado da sequência da `stages_journey`)
- `EventCard` — card por evento raw (origin badge + nome + tag inline)
  - Colapsável: lista de dispatches filhos (`dispatch_jobs` vinculados ao evento)
  - Footer: UTMs do evento
  - Link "Ver detalhes" para payload completo
- `OriginBadge` — cor por source: `tracker.js` (azul), `webhook:guru` (laranja), `webhook:sendflow` (verde), `api` (cinza)
- `TagBadge` — tag inline no EventCard quando evento disparou promoção de tag

### EventCard — dispatches filhos
Cada EventCard expande para mostrar `dispatch_jobs` associados ao evento:
- Destination pill: `GA4 MP` / `Meta CAPI`
- Status: ✓ succeeded / ⚠ skipped / ✗ failed
- Latência + attempt number

---

## 4. Aba Eventos

Implementada em `events-tab.tsx` (renomeado de `lead-timeline-client.tsx`). Usa `use-timeline.ts`.

Filtros disponíveis:
- Tipo de node (`types`) — select múltiplo (NodeType)
- Status (`statuses`) — select múltiplo (NodeStatus)
- Período (since) — ISO 8601 passado ao endpoint `since=`

**Mudança de contrato (Sprint 17):** o parâmetro `filters` da API agora aceita JSON `{ types?: NodeType[], statuses?: NodeStatus[] }`. CSV não é mais suportado. O Zod schema do endpoint removeu `.strict()` para aceitar campos extras sem rejeitar.

Comportamento anterior de timeline flat preservado nesta aba.

---

## 5. Aba Despachos

Implementada em `dispatches-tab.tsx`.

Tabela de `dispatch_jobs` filtrável por:
- Destination (`GA4 MP` / `Meta CAPI`) — pills coloridas
- Status (`succeeded`, `failed`, `skipped`, `dead_letter`)
- Período

Colunas: destination, event_name, status, attempt_count, latency_ms, dispatched_at, link para payload.

Re-dispatch (C.3) acessível nesta aba para OPERATOR/ADMIN.

---

## 6. Aba Atribuição

Implementada em `attribution-tab.tsx`.

Tabela de touchpoints UTM + click_ids:
- first_touch e last_touch (destacados)
- Colunas: utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, at

---

## 7. Aba Consent

Implementada em `consent-tab.tsx`.

Duas seções:
1. **Estado atual** — 5 finalidades com status boolean (analytics, marketing, ad_user_data, ad_personalization, customer_match) + `updated_at`
2. **Histórico** — lista de `lead_consents` rows com timestamp e delta de mudança

---

## 8. Aba Identidade

Implementada em `identity-tab.tsx`. **Gated: apenas OPERATOR/ADMIN.**

Seções:
- Hashes externos: `email_hash_external`, `phone_hash_external`, `fn_hash`, `ln_hash`
- Cookies: `fbp`, `fbc`, `_ga`
- Geo + device: `geo_city`, `geo_region_code`, `geo_country`, `user_agent` (extraídos do evento mais recente)

---

## 9. Deep-link via URL

Implementado em `tabs-with-url-sync.tsx` (Radix Tabs + `useSearchParams`).

`?tab=jornada` | `?tab=eventos` | `?tab=despachos` | `?tab=atribuicao` | `?tab=consent` | `?tab=identidade`

Browser back/forward navega entre abas. Compartilhar URL abre a aba correta.

---

## 10. Re-dispatch (C.3)

Em job com `status='dead_letter'` ou `'failed'` (final), botão **"Tentar novamente"** (aba Despachos ou Jornada):

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

## 11. Inline help: "Por que isso aconteceu?"

Em qualquer node 🔴/🟡, link inline abre painel lateral (Sheet):

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

## 12. Componentes shadcn / custom

- `<Tabs>` (Radix) + `tabs-with-url-sync.tsx` para deep-link
- `LeadSummaryHeader` — server component, fetch `GET /v1/leads/:id/summary`
- `StageDivider`, `OriginBadge`, `MoneyValue`, `TagBadge`, `PageInline` — em `journey-helpers.tsx`
- `EventCard` — collapsível com dispatches filhos
- `<Collapsible>` para expandir payload
- `<Sheet>` para "Por que isso aconteceu?"
- `<AlertDialog>` para confirmar re-dispatch
- `<Badge>` para status colorido
- `<Button variant="ghost">` para deep-links
- `<DropdownMenu>` para filtros
- `use-timeline.ts` — SWR Infinite hook compartilhado entre aba Jornada e aba Eventos

---

## 13. Performance

- SWR Infinite: carrega 50 nodes por página (cursor-based) — botão "Carregar mais antigos"
- `GET /v1/leads/:id/summary` com `Cache-Control: private, max-age=15` — evita re-fetch em troca de aba
- Fetch paralelo (`identity` + `summary`) no `page.tsx` (server component)
- Lead com > 500 nodes (caso raro) tem aviso: "Mostrando apenas dispatches deste mês — [Ver tudo]"

---

## 14. Estados

- **Loading:** skeleton de 5 nodes (aba Jornada/Eventos); skeleton de header
- **Empty:** "Esse lead ainda não tem atividade registrada"
- **Error:** "Não foi possível carregar a timeline. [Tentar novamente]"
- **Lead arquivado/SAR:** banner topo "Este lead foi anonimizado por SAR — dados removidos"

---

## 15. Endpoints consumidos

- `GET /v1/leads/:public_id` — dados básicos do lead (display_name, status)
- `GET /v1/leads/:public_id/summary` — LeadSummaryHeader (stages, tags, attribution, consent, metrics) — **novo Sprint 17**
- `GET /v1/leads/:public_id/timeline?cursor=...&since=...&filters=<JSON>&limit=50` — nodes (aba Jornada + Eventos)
- `POST /v1/dispatch-jobs/:id/replay` — re-dispatch (audit log)
- `POST /v1/leads/:public_id/decrypt-pii` — PRIVACY apenas (audit log)
- `GET /v1/help/skip-reason/:reason` — conteúdo "Por que isso aconteceu?"

---

## 16. A11y

- Tabs navegáveis por teclado (arrow keys Radix)
- EventCards navegáveis por Tab; Enter/Space expande
- Status de cada node anunciado: `aria-label="Despachado para Meta CAPI: sucesso"`
- Linha visual decorativa marcada `aria-hidden="true"`
- Live region para feedback de re-dispatch ("Re-dispatch enfileirado")
- Cores nunca isoladas — todo status ✓/⚠/✗ tem ícone + label

---

## 17. Test harness

- `tests/integration/control-plane/lead-timeline.test.tsx` — render + filtros
- `tests/integration/control-plane/lead-timeline-payload-authz.test.tsx` — sanitização por role
- `tests/integration/control-plane/lead-timeline-redispatch.test.tsx` — fluxo C.3 + audit log
- `tests/integration/control-plane/lead-timeline-pii-decrypt.test.tsx` — PRIVACY + audit log
- E2E: "Lead falha em Meta → MARKETER vê reason humanizada na timeline" ([docs/80-roadmap/98-test-matrix-by-sprint.md](../80-roadmap/98-test-matrix-by-sprint.md))

---

## 18. Referências

- [02-information-architecture.md](./02-information-architecture.md) — rota
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — mensagens humanizadas
- [05-screen-integration-health.md](./05-screen-integration-health.md) — drill-down complementar
- [20-domain/04-mod-identity.md](../20-domain/04-mod-identity.md) — Lead, aliases, merges
- [20-domain/05-mod-event.md](../20-domain/05-mod-event.md) — events
- [20-domain/08-mod-dispatch.md](../20-domain/08-mod-dispatch.md) — dispatch_jobs/attempts
- [50-business-rules/BR-DISPATCH.md](../50-business-rules/BR-DISPATCH.md) — re-dispatch / DLQ
- [50-business-rules/BR-PRIVACY.md](../50-business-rules/BR-PRIVACY.md) — decrypt PII audit
- [30-contracts/03-timeline-event-catalog.md](../30-contracts/03-timeline-event-catalog.md) — TE-* canônicos
- [30-contracts/05-api-server-actions.md](../30-contracts/05-api-server-actions.md) — `GET /v1/leads/:id/summary` + timeline params atualizados
