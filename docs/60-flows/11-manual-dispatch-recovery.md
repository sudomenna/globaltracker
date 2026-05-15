# Flow 11 — Manual Dispatch Recovery

Runbook para recuperar leads que ficaram sem evento e/ou sem disparo para plataformas externas (Meta CAPI, GA4, Google Ads) por falha de pipeline, bug de snippet ou qualquer outra causa.

---

## Quando usar

- Lead existe no banco mas está sem evento específico (ex.: `Lead`, `Purchase`) por falha do tracker, race condition no snippet, ou processamento perdido.
- `dispatch_jobs` existem mas ficaram em `failed`/`skipped`/`dead_letter` e precisam ser reprocessados.
- Recovery retroativo após bug corrigido que afetou N leads.

**Não usar** para eventos que *nunca devem ter ocorrido* — recovery sintético é decisão de produto, não técnica.

---

## Pré-requisitos

| Item | Valor |
|---|---|
| DB URL | `postgresql://postgres:<senha>@db.kaxcmhfaqrxwnpftkslj.supabase.co:5432/postgres` (senha em `.env.local`, escapar `//` como `%2F%2F`) |
| Edge API | `https://globaltracker-edge.globaltracker.workers.dev` |
| Workspace ID | `74860330-a528-4951-bf49-90f0b5c72521` |
| Meta Pixel ID | `149334790553204` |

---

## Parte A — Inserir evento faltante

Use quando o evento em si nunca chegou ao banco (ex.: tracker não disparou antes do redirect).

### A1. Verificar estado do lead

```sql
SELECT
  l.id::text AS lead_id,
  l.created_at,
  l.lifecycle_status,
  (SELECT count(*) FROM events e WHERE e.lead_id = l.id) AS total_events,
  (SELECT string_agg(e.event_name, ', ' ORDER BY e.received_at)
     FROM events e WHERE e.lead_id = l.id) AS event_names,
  (SELECT count(*) FROM lead_attributions la WHERE la.lead_id = l.id) AS attributions,
  (SELECT count(*) FROM lead_stages ls WHERE ls.lead_id = l.id) AS stages
FROM leads l
WHERE l.id = '<lead_id>'::uuid;
```

### A2. Coletar campos necessários do `lead_identify`

```sql
SELECT
  e.id::text, e.event_id, e.visitor_id,
  e.launch_id::text, e.page_id::text,
  e.attribution, e.user_data
FROM events e
WHERE e.lead_id = '<lead_id>'::uuid
  AND e.event_name = 'lead_identify';
```

### A3. Checar o `event_config` da page

```sql
SELECT id::text, public_id, role, event_config
FROM pages
WHERE id = '<page_id>'::uuid;
```

Confirmar que o evento a recuperar está em `event_config.canonical` ou `event_config.custom`. Caso contrário, o dispatcher não seria criado normalmente — decidir explicitamente se ainda assim vale o recovery.

### A4. Inserir o evento + stage + dispatch_job (transação única)

```sql
WITH lead_data AS (
  SELECT * FROM (VALUES
    (
      '<lead_id>'::uuid,
      '<lead_created_at>'::timestamptz,  -- usar o created_at do lead
      '<page_id>'::uuid,
      '<attribution_jsonb>'::jsonb        -- '{}'  ou copiar de lead_identify
    )
  ) AS t(lead_id, lead_created_at, page_id, attribution)
),
new_events AS (
  INSERT INTO events (
    workspace_id, launch_id, page_id, lead_id, visitor_id,
    event_id, event_name, event_source, event_time, received_at,
    attribution, user_data, custom_data, consent_snapshot, request_context,
    processing_status, is_test
  )
  SELECT
    '74860330-a528-4951-bf49-90f0b5c72521'::uuid,
    '<launch_id>'::uuid,
    ld.page_id,
    ld.lead_id,
    NULL,                             -- visitor_id NULL se indisponível
    gen_random_uuid()::text,          -- novo event_id (tracker UUID)
    '<EventName>',                    -- ex.: 'Lead', 'Purchase'
    'admin',                          -- event_source obrigatório: 'admin'
    ld.lead_created_at,
    NOW(),
    ld.attribution,
    '{}'::jsonb,
    '{}'::jsonb,
    -- consent_snapshot: OBRIGATÓRIO preencher para não ser skipped pelo dispatcher
    '{"analytics":"granted","marketing":"granted","ad_user_data":"granted","ad_personalization":"granted","customer_match":"granted"}'::jsonb,
    '{}'::jsonb,
    'accepted',
    false
  FROM lead_data ld
  RETURNING id, event_id, lead_id, event_time
),
new_stages AS (
  INSERT INTO lead_stages (workspace_id, lead_id, launch_id, stage, source_event_id, ts)
  SELECT
    '74860330-a528-4951-bf49-90f0b5c72521'::uuid,
    ne.lead_id,
    '<launch_id>'::uuid,
    '<stage_name>',     -- ex.: 'lead_workshop', 'purchased_workshop'
    ne.id,
    ne.event_time
  FROM new_events ne
  ON CONFLICT DO NOTHING
  RETURNING lead_id::text, stage
),
new_jobs AS (
  INSERT INTO dispatch_jobs (
    workspace_id, lead_id, event_id, event_workspace_id,
    destination, destination_account_id, destination_resource_id,
    idempotency_key, status
  )
  SELECT
    '74860330-a528-4951-bf49-90f0b5c72521'::uuid,
    ne.lead_id,
    ne.id,
    '74860330-a528-4951-bf49-90f0b5c72521'::uuid,
    'meta_capi',
    '149334790553204',
    '149334790553204',
    -- idempotency_key único por tentativa; incrementar sufixo em reprocessamentos
    encode(sha256(('meta_capi:recovery:v1:' || ne.event_id)::bytea), 'hex'),
    'failed'            -- 'failed' para que o replay endpoint aceite imediatamente
  FROM new_events ne
  RETURNING id::text AS dispatch_job_id, lead_id::text
)
SELECT ne.lead_id::text, ne.id::text AS event_id, ns.stage, nj.dispatch_job_id
FROM new_events ne
LEFT JOIN new_stages ns ON ns.lead_id = ne.lead_id::text
LEFT JOIN new_jobs nj ON nj.lead_id = ne.lead_id::text;
```

> **Atenção — `consent_snapshot`**: inserir com `{}` faz o dispatcher marcar `skipped` com `consent_denied:ad_user_data`. Sempre preencher com `granted` para todos os campos quando o contexto confirma que o usuário consentiu (ex.: página com `fbq('consent','grant')` no head).

> **Atenção — `event_source`**: o campo tem CHECK constraint. Valores permitidos: `tracker`, `webhook:guru`, `webhook:hotmart`, `webhook:kiwify`, `webhook:stripe`, `webhook:webinarjam`, `webhook:typeform`, `webhook:tally`, `webhook:sendflow`, `webhook:onprofit`, `redirector`, `system`, `admin`. Usar `admin` para recovery manual.

---

## Parte B — Replay de dispatch_job existente

Use quando o evento já existe no banco mas o `dispatch_job` está em `failed`, `skipped` ou `dead_letter`.

### B1. Verificar status dos jobs

```sql
SELECT dj.id::text, dj.status, dj.skip_reason, dj.destination,
       da.error_code, da.error_message
FROM dispatch_jobs dj
LEFT JOIN dispatch_attempts da ON da.dispatch_job_id = dj.id
WHERE dj.lead_id = '<lead_id>'::uuid
ORDER BY dj.created_at DESC;
```

### B2. Chamar o replay endpoint

```bash
curl -X POST \
  "https://globaltracker-edge.globaltracker.workers.dev/v1/dispatch-jobs/<job_id>/replay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <qualquer-token-nao-vazio>" \
  -H "X-Workspace-Id: 74860330-a528-4951-bf49-90f0b5c72521" \
  --data-raw '{"justification":"<motivo do replay — obrigatório>"}'
```

Resposta esperada: `{"new_job_id":"<uuid>","status":"queued"}`.

> O replay cria um job filho e enfileira no `gt-dispatch`. O job original permanece inalterado (ADR-025).

> O endpoint **não aceita** jobs com `status='pending'` ou `'processing'` — retorna `job_in_progress`. Aguardar conclusão ou, se travado, atualizar status para `failed` via SQL antes de reenviar.

### B3. Verificar resultado

```sql
SELECT dj.id::text, dj.status, dj.skip_reason,
       da.status AS attempt_status, da.error_code,
       da.response_payload_sanitized
FROM dispatch_jobs dj
LEFT JOIN dispatch_attempts da ON da.dispatch_job_id = dj.id
WHERE dj.id = '<new_job_id>'::uuid;
```

**Sucesso**: `status='succeeded'`, `events_received: 1` na response do Meta.

**`consent_denied:ad_user_data`**: o evento original tem `consent_snapshot: {}`. Atualizar via:
```sql
UPDATE events
SET consent_snapshot = '{"analytics":"granted","marketing":"granted","ad_user_data":"granted","ad_personalization":"granted","customer_match":"granted"}'::jsonb
WHERE id = '<event_uuid>'::uuid;
```
Depois criar novo `dispatch_job` com `status='failed'` (idempotency_key diferente — adicionar `:v2`) e repetir o replay.

---

## Parte C — Recovery em lote (múltiplos leads)

Repetir o CTE da Parte A com múltiplas linhas no `VALUES`. Exemplo com 3 leads:

```sql
WITH lead_data AS (
  SELECT * FROM (VALUES
    ('<lead_id_1>'::uuid, '<ts_1>'::timestamptz, '<page_id_1>'::uuid, '<attr_1>'::jsonb),
    ('<lead_id_2>'::uuid, '<ts_2>'::timestamptz, '<page_id_2>'::uuid, '<attr_2>'::jsonb),
    ('<lead_id_3>'::uuid, '<ts_3>'::timestamptz, '<page_id_3>'::uuid, '<attr_3>'::jsonb)
  ) AS t(lead_id, lead_created_at, page_id, attribution)
),
-- ... mesmo CTE da Parte A ...
```

Para o replay em lote via shell:

```bash
for job_id in "<id1>" "<id2>" "<id3>"; do
  curl -s -X POST \
    "https://globaltracker-edge.globaltracker.workers.dev/v1/dispatch-jobs/${job_id}/replay" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer admin-recovery" \
    -H "X-Workspace-Id: 74860330-a528-4951-bf49-90f0b5c72521" \
    --data-raw '{"justification":"<motivo>"}'
  echo ""
done
```

---

## Parte D — Recovery via mirror N8N (gap de webhook inbound)

Use quando um provedor (SendFlow, OnProfit, etc.) pausou nosso webhook após falhas consecutivas (proteção anti-loop padrão) e os events do gap **nunca chegaram em `raw_events`** — mas existem em um workflow N8N paralelo que espelha o mesmo webhook.

### Quando isto se aplica

- Outage do nosso edge (Hyperdrive, deploy ruim, etc.) → provedor recebeu 5xx → desativou webhook.
- "Resend failed events" do painel do provedor não está disponível ou não cobre o período.
- Existe um workflow N8N de Tiago (`https://mennaworks.app.n8n.cloud`) registrado como endpoint paralelo do mesmo provedor.

### D1. Descobrir workflow espelho

```bash
curl -sS "https://mennaworks.app.n8n.cloud/api/v1/workflows?limit=250&active=true" \
  -H "X-N8N-API-KEY: <JWT>" \
  | jq '.data[] | {id, name, paths: [.nodes[]?.parameters?.path // empty]}'
```
Procurar o workflow cujo node Webhook tem `parameters.path` casando com a URL configurada no provedor.

### D2. Confirmar tamanho do gap

```sql
SELECT MAX(received_at) AS last_received
FROM raw_events
WHERE payload->>'_provider' = '<provider>';
```
Comparar com o `startedAt` mais recente das execuções do workflow N8N:

```bash
curl -sS "https://mennaworks.app.n8n.cloud/api/v1/executions?workflowId=<wid>&limit=10" \
  -H "X-N8N-API-KEY: <JWT>" | jq '.data[] | {id, startedAt, status}'
```

### D3. Rodar script de replay

Script-base: `scripts/maintenance/sendflow_n8n_replay.mjs` (gitignored — `.mjs` em `scripts/maintenance/` contêm conn-string com senha; ver `.gitignore`). Reconstruir localmente seguindo os passos D1-D4 desta seção. Pontos a ajustar:

- `WORKFLOW_ID` — id do workflow descoberto em D1.
- `CUTOFF` — `MAX(received_at)` da query D2.
- `WEBHOOK_BASE` e header `sendtok` (ou auth equivalente) — endpoint do provedor.
- **Chave de dedup** — varia por provedor. Validar com sanity check antes do replay:
  - **SendFlow**: `truncSec(data.createdAt) + data.number + data.groupId`. NÃO usar `body.id` (regerado por delivery).
  - Outros providers: assumir o mesmo padrão "id regenerado por delivery" e dedupar por conteúdo (timestamp truncado + chave natural do evento).

Sanity gate antes de replay real: amostra de 8 execuções **anteriores** ao cutoff deve dar 8/8 `OK` (presentes em `raw_events`). Se houver `MISSING`, refinar a chave de dedup (drift de ms, formato de timestamp diferente, etc.).

```bash
# Preview
DRY_RUN=1 N8N_API_KEY=<key> SENDFLOW_SENDTOK=<token> \
  node scripts/maintenance/sendflow_n8n_replay.mjs

# Real
N8N_API_KEY=<key> SENDFLOW_SENDTOK=<token> \
  node scripts/maintenance/sendflow_n8n_replay.mjs
```

### D4. Validação

```sql
SELECT processing_status, COUNT(*)
FROM raw_events
WHERE payload->>'_provider' = '<provider>'
  AND received_at > NOW() - INTERVAL '30 minutes'
GROUP BY processing_status;
```
Esperado: total = `sent` do script. `pending` é normal — outbox poller processa em ≤10min.

### D5. Reativar webhook no painel do provedor

Recovery via N8N preenche o gap, mas **não conserta o webhook original**. User deve reativar no painel do provedor para fluxo normal voltar.

### Quirks descobertos por provedor

| Provedor | Quirk |
|---|---|
| SendFlow | `body.id` único por delivery → não dedup por id. `data.createdAt` drift ~1ms entre destinos → truncar para segundo. Header auth (`sendtok`), não query string. |

---

## Checklist pós-recovery

- [ ] `dispatch_jobs` finais com `status='succeeded'` e `events_received: 1`
- [ ] Timeline do lead no CP mostra o evento recuperado
- [ ] `lead_stages` correto (`lead_workshop`, `purchased_workshop`, etc.)
- [ ] Meta Events Manager: confirmar que o evento aparece em ~1h (não é instantâneo)
- [ ] Nenhum job ficou em `pending` sem entrar na fila (usar replay ou verificar outbox poller em ≤10min)

---

## Histórico de uso

| Data | Leads | Evento | Causa | Resultado |
|---|---|---|---|---|
| 2026-05-10 | b238a9af, 0cecf516, 8edc5512 | `Lead` | Race bug snippet workshop (`attribution: {}` + redirect fora do `withTracker`). Fix: commit `5b32b5b`. | 3/3 `succeeded` no Meta CAPI |
| 2026-05-15 | 41 (`group.updated.members.added`) | `custom:wpp_joined` / `custom:wpp_joined_vip_main` | SendFlow pausou webhook após 16h outage Hyperdrive (12-13/05). Gap: 13/05 00:20 UTC → 15/05 02:10 UTC. | Recovery via mirror N8N (Parte D) — 41/41 raw_events inseridos, 47 dups corretamente pulados. Sanity 8/8 pré-cutoff. |
