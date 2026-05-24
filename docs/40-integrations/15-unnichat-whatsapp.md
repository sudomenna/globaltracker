# Unnichat WhatsApp (outbound — BSP)

## Papel no sistema

Provedor de mensageria WhatsApp (BSP — Business Solution Provider) usado pela **cadência de recuperação de carrinho abandonado**. Quando um lead inicia checkout de uma oferta `bait_*` e não conclui dentro da janela elegível, o GlobalTracker dispara um template aprovado pela Meta (via Unnichat) tentando recuperar a venda.

É a **primeira integração outbound não-pixel** do sistema: ao contrário de Meta CAPI / Google Ads / GA4 (que enviam *conversões* para plataformas de ads), Unnichat envia *mensagens* a contatos reais via WhatsApp.

Entregue 2026-05-23. Schema em prod desde 2026-05-20 (migration `0054`). Cron + sender + fixes de hoje (ensure-contact + URL param) em prod via `T-RECOVERY-002`/`002b`/`003`.

> **Não há doc pública estável da API Unnichat** além do Swagger em `https://unnichat.com.br/api/api-docs`. Boa parte das decisões abaixo (shape camelCase, resposta de "contato não encontrado", obrigatoriedade de contato pré-existente) foi inferida empiricamente e validada em prod. Ver ADR-048.

## Arquitetura do recovery (cron → creator → sender)

A automação roda inteiramente em **CF Cron Trigger** `*/2 * * * *` no `scheduledHandler` de [`apps/edge/src/index.ts`](../../apps/edge/src/index.ts) (branch ~L2501). A cada 2 minutos, por workspace:

```
cron */2
  ├─ 1. createPendingRecoveryJobs(db, workspaceId)   [recovery-job-creator.ts]
  │       detecta abandono → materializa recovery_jobs status='queued'
  └─ 2. sendPendingRecoveryJobs(db, workspaceId, env) [recovery-sender.ts]
          drena ≤50 jobs prontos → ensure contact → dispara template → tag
```

> Hoje o cron roda apenas no workspace dev fixo (Outsiders Digital). Pula com log `recovery_cron_skipped_no_workspace` / `recovery_cron_skipped_no_api_key` quando ausente.

### 1. `createPendingRecoveryJobs` — detecção de abandono

Em [`apps/edge/src/lib/recovery-job-creator.ts`](../../apps/edge/src/lib/recovery-job-creator.ts). NÃO envia mensagens — só materializa rows `recovery_jobs` `status='queued'`.

Elegibilidade (CTE única, idempotente):

- Evento `InitiateCheckout` na janela `[NOW()-60min, NOW()-6min]` (6min = lower bound de "abandono confirmado"; 60min = upper bound de elegibilidade — decisão de produto).
- `funnel_role` resolvido == `campaign.trigger_funnel_role` (alvo: `bait_offer`).
- `e.lead_id IS NOT NULL` **e** `leads.phone_enc IS NOT NULL` (BR-IDENTITY: sem telefone criptografado o sender não tem como despachar).
- `lifecycle = 'lead'` **OU** (`lifecycle = 'cliente'` **E** status do checkout ∈ `recoverable_statuses` — default seed: `CART_ABANDONED`, `WAITING`, `CANCELED`, `REJECTED`, `REFUSED` — **E** não existe `Purchase` de OUTRO `bait_*` no mesmo launch — supressão).
- `INSERT ... ON CONFLICT (campaign_id, lead_id, step_index, trigger_event_id) DO NOTHING` (INV-RECOVERY-JOB-001 — idempotência por tick).

`funnel_role` é derivado via `COALESCE(custom_data->>'funnel_role', JOIN products → launch_products)` — cobre Guru (grava direto em `custom_data`) e OnProfit (resolve por `product_id`). Status do checkout: `webhook:onprofit` lê `custom_data->>'onprofit_status'`; `webhook:guru` materializa constante `'CART_ABANDONED'` (Guru não grava status; presença do `InitiateCheckout` já implica abandono — ver [`13-digitalmanager-guru-webhook.md`](./13-digitalmanager-guru-webhook.md)).

### 2. `sendPendingRecoveryJobs` — dispatch

Em [`apps/edge/src/lib/recovery-sender.ts`](../../apps/edge/src/lib/recovery-sender.ts). Drena ≤50 jobs por tick. Para cada job:

1. **Janela de envio** — avaliada no próprio SQL no fuso da campanha: `(NOW() AT TIME ZONE c.send_window_tz)::time BETWEEN c.send_window_start AND c.send_window_end`. Janela operacional: **07:15–22:30 BRT** (não disparar de madrugada).
2. **Supressão final** — lead comprou outro `bait_*` no mesmo launch *após* o job ser agendado (`received_at > job.created_at`) → `status='suppressed'`, sem envio.
3. **Decrypt PII** — `decryptPii()` workspace-scoped (AES-256-GCM + HKDF, BR-PRIVACY-003/004) para phone (`leads.phone_enc`), nome (`leads.name` plaintext ou `leads.name_enc`) e email (`leads.email_enc`, opcional). Phone decifrado vive só em memória durante o dispatch — **jamais é logado** (BR-PRIVACY-001).
4. **Ensure contact** — `ensureUnnichatContact` (ver flow abaixo).
5. **Resolve placeholders** — slots do template (`body_params`, `url_button_params`) resolvidos a partir do primeiro nome decifrado; `contactName` cai em fallback `amigo(a)` quando ausente.
6. **Dispatch** — `dispatchToUnnichat` → `POST /api/meta/templates`.
7. **Tag pós-envio** — best-effort, quando a campanha define `unnichat_sent_tag_id`.
8. **Transição de status** conforme política de retry.

## Flow de envio Unnichat (ensure-contact-before-send)

> **Root cause do bug "Contact not found!" (FIX 1, 2026-05-23):** a API `/api/meta/templates` **exige que o telefone já exista como contato** na Unnichat. Sem contato pré-existente, ela responde 4xx `Contact not found!` (69/81 jobs falhavam). A solução é garantir o contato *antes* de enviar.

### `ensureUnnichatContact` (search → create)

```
1. SEARCH  POST /api/contact/search { phone }
     ENCONTRADO     → { success:true, data:[{ id, ... }] }  → usa data[0].id
     NÃO-ENCONTRADO → { success:true, data:[{}] }            → array com objeto vazio
2. CREATE  POST /api/contact { name, phone, email }   (só quando não existe)
     name e email são OPCIONAIS (omitidos quando ausentes)
     extrai id defensivamente: data.id | data[0].id | id (string ou number)
```

Retorna `{ ok: true, contactId }` ou `{ ok: false, status, error }` (não joga — o caller decide a transição do job). 200 sem id reconhecível é tratado como falha transitória (`status 502`).

### `dispatchToUnnichat` (envio do template)

```
POST /api/meta/templates
{
  "phone": "<dígitos>",
  "templateId": "<id do template Meta>",
  "bodyParameters": [{ "type": "text", "text": "..." }],
  "urlButtonParameters": [{ "type": "text", "text": "..." }]
}
```

> **Payload é camelCase** (`templateId`, `bodyParameters`, `urlButtonParameters`) — confirmado inspecionando o bundle do app Unnichat (`templateId` 57×, `bodyParameters` 41×, `urlButtonParameters` 29×; zero ocorrências das variantes snake_case). W2 inferiu snake_case por engano; corrigido em W3 antes do go-live.
>
> O envio é **por `phone`**, não por `contactId` — o contato precisa existir (passo ensure) mas o template é endereçado pelo telefone.

### Tag pós-envio

Após `status=sent`, se a campanha define `recovery_campaigns.unnichat_sent_tag_id`:

```
POST /api/contact/{id}/tags { tag_id }
```

**Best-effort**: falha de tag NUNCA derruba o job nem altera o contador `sent` (apenas log `recovery_unnichat_tag_failed`). `tag_id` e `contactId` são IDs internos da Unnichat (sem PII). O id da tag é obtido via `GET /api/tags`.

## Gotcha do URL button param (FIX 2, 2026-05-23)

O parâmetro dinâmico `{{1}}` de um **URL button** de template WhatsApp **percent-encoda caracteres reservados** (`?`, `=`) ao montar a URL final. Logo, se o valor de `{{1}}` for `?off=Fn4XA0`, a Meta produz:

```
fvOsQjDO%3Foff%3DFn4XA0      ← URL quebrada (? e = encodados)
```

**Correção:** mover a parte estática `?off=` para dentro do **template** e deixar o `{{1}}` carregar apenas o valor alfanumérico:

```
Template URL estática:  https://.../fvOsQjDO?off={{1}}
Valor do {{1}}:         Fn4XA0           ← só alfanumérico, não encoda
```

> **Não há fix só de código.** Exige editar o template no painel + **re-aprovação Meta**. A migration `0057` ajustou o seed de `url_button_params` para `Fn4XA0` (valor alfanumérico), mas o template em si tem que ter `?off={{1}}` na parte estática.

## Endpoints Unnichat

Base: `https://unnichat.com.br/api`. Swagger: `https://unnichat.com.br/api/api-docs`.

| Método | Path | Uso |
|---|---|---|
| `POST` | `/api/contact/search` | Resolve `contactId` por `{ phone }`. Não-encontrado = `{ success:true, data:[{}] }`. |
| `POST` | `/api/contact` | Cria contato `{ name?, phone, email? }`. |
| `POST` | `/api/contact/{id}/tags` | Aplica `{ tag_id }` a um contato (best-effort, pós-envio). |
| `POST` | `/api/meta/templates` | Envia template aprovado: `{ phone, templateId, bodyParameters, urlButtonParameters }` (camelCase). |
| `GET` | `/api/tags` | Lista tags do workspace Unnichat (obter `tag_id` para `unnichat_sent_tag_id`). |

## Autenticação

Header `Authorization` carrega o token **já com o prefixo `"Bearer "`** — secret `UNNICHAT_API_KEY` (Wrangler secret). **Não concatenar `"Bearer "`** no código; usar o valor verbatim.

```ts
headers: {
  'Content-Type': 'application/json',
  Authorization: env.UNNICHAT_API_KEY, // já contém "Bearer " — não concatenar
}
```

> **Segurança:** `UNNICHAT_API_KEY` é segredo de envio de mensagens — não logar, não expor em respostas. Vive em Wrangler secrets, propagado ao `scheduledHandler` via `env`.

## Status dos `recovery_jobs`

`status` final ∈ `{ queued, sent, failed, suppressed }` (INV-RECOVERY-JOB-002).

| Status | Significado |
|---|---|
| `queued` | Aguardando dispatch (criado pelo creator; ou re-enfileirado por erro transitório). |
| `sent` | Template enviado com 2xx. **Sempre** acompanhado de `sent_at=NOW()` no mesmo UPDATE (INV-RECOVERY-JOB-003) + `unnichat_message_id` (quando a resposta traz). |
| `failed` | Falha permanente (ver causas abaixo). |
| `suppressed` | Lead comprou outro `bait_*` antes do dispatch (não enviado). |

### Política de retry

| Resultado do dispatch | Transição |
|---|---|
| `2xx` | `sent` |
| `4xx` | `failed` (permanente — ex.: `Contact not found!` antes do FIX 1) |
| `5xx` / rede / parse | mantém `queued` + `attempts++`; vira `failed` quando `attempts ≥ 5` |
| `decrypt_failed` | `failed` (permanente — ciphertext corrupto / key version desconhecida) |
| phone vazio após sanitize | `failed` (permanente) |

`response_payload` é sanitizado antes de persistir (BR-PRIVACY-001) e clampado a ~4 KB.

## Schema

Migrations:

| Migration | Conteúdo |
|---|---|
| `0054` | 3 tabelas: `recovery_campaigns`, `recovery_templates`, `recovery_jobs`. RLS dual-mode. |
| `0055` | Seed da campanha do launch `wkshop-cs-jun26` + template Meta `2186334448831228`. |
| `0056` | Coluna `recovery_campaigns.unnichat_sent_tag_id` (`text` nullable) — tag pós-envio. |
| `0057` | Fix de `url_button_params` → `Fn4XA0` (valor alfanumérico do `{{1}}`, ver gotcha acima). |

Idempotência do creator: UNIQUE `(campaign_id, lead_id, step_index, trigger_event_id)`.

## Observabilidade

Logs estruturados (sem PII em claro — BR-PRIVACY-001):

- `recovery_cron_skipped_no_workspace` / `recovery_cron_skipped_no_api_key` (info — pré-condições do cron)
- `recovery_cron_tick_done` (info — resumo do tick: created + sent/failed/suppressed)
- `recovery_jobs_created` (info — `scanned` + `created` do creator)
- `recovery_sender_tick_done` (info — `sent`/`failed`/`suppressed`/`scanned`)
- `recovery_sender_missing_master_key` (error — `PII_MASTER_KEY_V1` ausente)
- `recovery_sender_phone_decrypt_failed` / `_name_decrypt_failed` / `_email_decrypt_failed` (warn — só `code` + IDs internos)
- `recovery_unnichat_create_no_id` (warn — CREATE 200 sem id; loga só o *shape* da resposta)
- `recovery_unnichat_tag_failed` (warn — tag pós-envio falhou; job permanece `sent`)
- `recovery_suppression_check_failed` (warn — falha de DB na checagem; em dúvida NÃO suprime)

## Arquivos

- [`apps/edge/src/lib/recovery-job-creator.ts`](../../apps/edge/src/lib/recovery-job-creator.ts) — `createPendingRecoveryJobs`.
- [`apps/edge/src/lib/recovery-sender.ts`](../../apps/edge/src/lib/recovery-sender.ts) — `sendPendingRecoveryJobs`, `ensureUnnichatContact`, `dispatchToUnnichat`.
- [`apps/edge/src/lib/recovery-types.ts`](../../apps/edge/src/lib/recovery-types.ts) — tipos do dispatch/contact.
- [`apps/edge/src/index.ts`](../../apps/edge/src/index.ts) — wiring do cron `*/2 * * * *` (~L2501).
- Migrations `0054`–`0057` (ver tabela acima).

## Referências

- Swagger Unnichat: `https://unnichat.com.br/api/api-docs`
- ADR-048 — decisões de design da integração (ensure-contact, tag pós-envio, URL param estático).
- [`13-digitalmanager-guru-webhook.md`](./13-digitalmanager-guru-webhook.md) — origem dos eventos `InitiateCheckout` (abandoned → recovery).
- [`14-onprofit-webhook.md`](./14-onprofit-webhook.md) — segunda fonte de `InitiateCheckout` (status `WAITING`/`CART_ABANDONED`).
