# Mapeamento canônico de nomes de evento por plataforma

## Contexto

O campo `events.event_name` usa PascalCase alinhado à convenção Meta (ex.: `Lead`, `Purchase`).
Cada dispatcher é responsável por traduzir o nome interno para o nome esperado pela plataforma de destino.
**O dispatcher não deve passar `event_name` diretamente sem tradução** — isso viola a semântica de cada plataforma.

Regra arquitetural: a lógica de mapeamento reside no `mapper.ts` de cada dispatcher (domínio),
não na camada de rota. Ver [BR-DISPATCH] e docs de cada dispatcher em `apps/edge/src/dispatchers/`.

---

## Tabela de mapeamento

| Interno (`events.event_name`) | Meta CAPI | GA4 MP | Observações |
|---|---|---|---|
| `PageView` | `PageView` | `page_view` | GA4 auto-coleta via gtag; server-side via MP quando necessário |
| `Lead` | `Lead` | `generate_lead` | **Diferença semântica central**: Meta=sinal de conversão com parâmetros de identidade; GA4=evento analítico de geração de lead |
| `Contact` | `Contact` | `generate_lead` | GA4 não tem evento `contact` dedicado; semanticamente próximo de geração de lead |
| `ViewContent` | `ViewContent` | `view_item` | Meta=conteúdo genérico; GA4=item de catálogo (exige `items[]`) |
| `InitiateCheckout` | `InitiateCheckout` | `begin_checkout` | Mapeamento direto; GA4 exige `items[]` |
| `AddToCart` | `AddToCart` | `add_to_cart` | GA4 exige `items[]` com `item_id`/`item_name` |
| `AddToWishlist` | `AddToWishlist` | `add_to_wishlist` | GA4 exige `items[]` |
| `AddPaymentInfo` | `AddPaymentInfo` | `add_payment_info` | GA4 exige `items[]` e `payment_type` |
| `CompleteRegistration` | `CompleteRegistration` | `sign_up` | Meta=registro concluído; GA4=`sign_up` (parâmetro: `method`) |
| `Search` | `Search` | `search` | GA4 usa `search_term`; Meta usa `search_string` |
| `Purchase` | `Purchase` | `purchase` | GA4 exige `transaction_id`, `items[]`; Meta exige `currency`+`value` |
| `Subscribe` | `Subscribe` | *(sem equivalente)* | Enviar como evento custom no GA4 ou omitir; ver nota abaixo |
| `StartTrial` | `StartTrial` | *(sem equivalente)* | Enviar como evento custom no GA4 ou omitir |
| `Schedule` | `Schedule` | *(sem equivalente)* | Enviar como evento custom no GA4 ou omitir |
| `Donate` | `Donate` | *(sem equivalente)* | Semanticamente próximo de `purchase`; mapeamento depende de decisão de produto |
| `FindLocation` | `FindLocation` | *(sem equivalente)* | Sem equivalente GA4; omitir ou custom |
| `SubmitApplication` | `SubmitApplication` | `generate_lead` | Formulário de aplicação pode ser tratado como lead no GA4 |
| `CustomizeProduct` | `CustomizeProduct` | *(sem equivalente)* | Sem equivalente GA4 direto; omitir ou custom |

---

## Custom events — convenção e mapeamentos canônicos

Custom events permitem rastrear ações específicas do funil que não têm equivalente direto em
Meta/GA4 standard events (ex.: clique em CTA, entrada em grupo de WhatsApp, conclusão de aula).

### Convenção de nomenclatura

| Camada | Formato | Exemplo |
|---|---|---|
| Tracker (interno, `events.event_name`) | `custom:` + `snake_case` | `custom:click_buy_workshop` |
| Meta (Pixel + CAPI) | `PascalCase` (Meta standard quando possível) | `InitiateCheckout` |
| GA4 (gtag + MP) | `snake_case` (GA4 recommended quando possível) | `begin_checkout` |

**Regra crítica:** o nome enviado ao Meta pelo browser Pixel (`fbq('track', 'X')`) e o nome
enviado ao Meta CAPI server-side **devem ser idênticos** para Meta deduplicar via `event_id`.
Por isso o mapper `INTERNAL_TO_META_EVENT_NAME` traduz custom events para Meta standard events,
e o snippet browser dispara `fbq` com o mesmo nome standard.

### Custom events catalogados

| Interno (tracker) | Meta (CAPI + Pixel) | GA4 MP | Origem | Stage típico |
|---|---|---|---|---|
| `custom:click_buy_workshop` | `InitiateCheckout` | `begin_checkout` | Click CTA "comprar workshop" | `clicked_buy_workshop` |
| `custom:click_buy_main` | `InitiateCheckout` | `begin_checkout` | Click CTA "comprar oferta principal" | `clicked_buy_main` |
| `custom:click_wpp_join` | `Contact` | `join_group` | Click no link "entrar no grupo WhatsApp" | `clicked_wpp_join` |
| `custom:wpp_joined` | `Contact` | `join_group` | Webhook SendFlow `members.added` (compradores) | `wpp_joined` |
| `custom:wpp_joined_vip_main` | `Contact` | `join_group` | Webhook SendFlow `members.added` (grupo VIP) | `wpp_joined_vip_main` |
| `custom:wpp_left` | *(blocklist — analítico interno)* | *(blocklist)* | Webhook SendFlow `members.removed` | *(sem stage)* |
| `custom:watched_workshop` | `ViewContent` | `view_item` | Click "já assisti" na aula gravada | `watched_workshop` |
| `custom:survey_responded` | *(sem mapeamento)* | *(sem mapeamento)* | Submit do formulário de pesquisa pós-workshop | `survey_responded` |

### Como adicionar um novo custom event

Para introduzir um novo custom event (ex: `custom:click_buy_upsell`), atualizar **5 lugares**:

1. **Tracker (snippet de page)** — disparar `Funil.track('custom:click_buy_upsell')` no listener do botão.
2. **Meta CAPI mapper** — `apps/edge/src/dispatchers/meta-capi/mapper.ts` constante `INTERNAL_TO_META_EVENT_NAME`: adicionar `'custom:click_buy_upsell': 'InitiateCheckout'` (ou outro standard semanticamente próximo).
3. **GA4 mapper** — `apps/edge/src/dispatchers/ga4-mp/mapper.ts` constante `INTERNAL_TO_GA4_EVENT_NAME`: adicionar `'custom:click_buy_upsell': 'begin_checkout'`.
4. **Snippet browser** — disparar `fbq('track', 'InitiateCheckout', {}, { eventID: window.__funil_event_id })` logo após `Funil.track()` para dedup.
5. **Page event_config** — adicionar `'click_buy_upsell'` ao array `custom` do `event_config` da page (sem prefixo `custom:` no array — o tracker prefixa automaticamente). Editar via UI do CP ou via migration de blueprint.

Se o custom event tem um stage associado, atualizar também o blueprint do `funnel_template`
(ver `docs/60-flows/10-create-new-launch-template.md` §4).

---

## Eventos GA4 sem equivalente Meta (somente funil de leads)

Estes eventos existem como recommended events no GA4 para rastreamento de funil de vendas B2B.
Não têm equivalente em Meta Standard Events — são enviados apenas ao GA4 quando o funil de leads
do workspace exige esse nível de granularidade.

| GA4 MP | Descrição |
|---|---|
| `qualify_lead` | Lead qualificado pelo time comercial |
| `disqualify_lead` | Lead descartado |
| `working_lead` | Lead em negociação ativa |
| `close_convert_lead` | Lead convertido em cliente |
| `close_unconvert_lead` | Lead encerrado sem conversão |

---

## Diferenças de parâmetros críticas

### `Lead` (Meta) vs `generate_lead` (GA4)

| Aspecto | Meta `Lead` | GA4 `generate_lead` |
|---|---|---|
| Propósito | Sinal de conversão para otimização de campanha | Evento analítico de rastreamento de funil |
| Parâmetros obrigatórios | `user_data` com pelo menos um identificador (`em`, `ph`, `fbc`, `fbp`) | `currency`, `value` (recomendados) |
| Parâmetros extras | `event_id` (dedup com Pixel browser) | `form_id`, `form_name`, `form_destination` (opcionais) |
| Impacto no sistema Meta | Alimenta otimização de entrega de anúncio | Não se aplica |

### `ViewContent` (Meta) vs `view_item` (GA4)

| Aspecto | Meta `ViewContent` | GA4 `view_item` |
|---|---|---|
| Escopo | Qualquer conteúdo (artigo, produto, LP) | Item de catálogo de e-commerce |
| Parâmetro-chave | `content_ids`, `content_type`, `content_name` | `items[]` com `item_id`, `item_name`, `price` |
| Obrigatoriedade de `items[]` | Não | Sim (para relatórios de e-commerce) |

### `CompleteRegistration` (Meta) vs `sign_up` (GA4)

| Aspecto | Meta `CompleteRegistration` | GA4 `sign_up` |
|---|---|---|
| Parâmetro-chave | `status` (bool), `currency`, `value` | `method` (string: 'email', 'google', etc.) |

---

## Eventos internos blocklist (não fanout)

Alguns eventos têm valor analítico interno mas não devem fanoutar para
plataformas de mídia (sem valor de otimização de campanha):

| Evento | Onde está blocklisted | Origem |
|---|---|---|
| `lead_identify` | `INTERNAL_ONLY_EVENT_NAMES` em `raw-events-processor.ts` | Tracker (rebind de identidade) |
| `event_duplicate_accepted` | `INTERNAL_ONLY_EVENT_NAMES` em `raw-events-processor.ts` | Tracker (dedup signal) |
| `custom:wpp_left` | `SENDFLOW_INTERNAL_ONLY` em `sendflow-raw-events-processor.ts` | Webhook SendFlow `members.removed` |

Eventos blocklisted **são persistidos em `events`** (para análise interna
e timeline do lead) mas **não geram dispatch_jobs** para Meta CAPI / GA4 /
Google Ads.

---

## Regra para eventos sem equivalente GA4

Quando `event_name` interno não tem equivalente GA4 recomendado, o `mapper.ts` do dispatcher GA4 deve:

1. Verificar se o workspace tem configuração de `custom_event_mapping` (futuro — Fase 6).
2. Se não houver: **retornar `null`** → dispatcher cria `dispatch_job` com `status='skipped'` e `skip_reason='no_ga4_equivalent'`.
3. Nunca enviar o nome Meta diretamente (ex.: `Subscribe`) como event name GA4 — quebraria reports.

---

## Referências

- [Meta Standard Events](https://developers.facebook.com/docs/meta-pixel/reference)
- [GA4 Recommended Events](https://developers.google.com/analytics/devguides/collection/ga4/reference/events)
- [Meta CAPI — mapper](../40-integrations/01-meta-capi.md)
- [GA4 MP — mapper](../40-integrations/06-ga4-measurement-protocol.md)
- [BR-DISPATCH](../50-business-rules/BR-DISPATCH.md)
