# RUNBOOK — Propagação de vendas (themembers + Unnichat + Brevo)

> **Como usar (cross-session):** cole este arquivo inteiro num chat novo, OU diga
> *"siga o RUNBOOK-propagacao-vendas.md"* + anexe o CSV novo (ou mande um lead avulso).
> Trabalhe no repo `/Users/tiagomenna/Projetos/GlobalTracker`. Credenciais em `.env.local`.

## Objetivo
Quando o Tiago enviar **(a)** um lead avulso `{nome, email, telefone, produto}` ou **(b)** um CSV
(export OnProfit/Guru), fazer duas coisas:
1. **Persistir TODAS as transações no GT** (nosso sistema de registro) — **independente do status.**
   Toda linha vira **lead** (criado/resolvido) + o **evento certo** conforme o status (PAID→Purchase,
   pending/aguardando/abandonado→InitiateCheckout — ver §1B). Atribuída ao **produto certo por
   `(provider, external_id)`**. Isto é obrigatório em toda atualização de vendas.
2. **Propagar só os PAID para os 3 sistemas externos**: **themembers** (matrícula/acesso),
   **Unnichat** (tags WhatsApp) e **Brevo** (listas). (Não-pagos NÃO entram nos externos.)

Tudo **idempotente** — re-rodar nunca duplica.

> **Regra de ouro (provider):** o **id do produto guia qual provider recebe a venda.** Produtos de
> nome idêntico existem em providers diferentes (ex.: "Workshop Contratos Societários" no `onprofit`
> **e** no `guru`). Para o **binding no GT**, casar SEMPRE por `(provider, external_id)` — nunca só
> por nome. Para os 3 sistemas externos o destino é provider-agnóstico (um comprador de workshop é
> comprador de workshop, não importa onde comprou), então lá o match por nome continua válido.

---

## 1) MAPA PRODUTO → DESTINOS EXTERNOS  (themembers / Unnichat / Brevo)

Estes destinos são **provider-agnósticos**. Identifique o produto por `product_name` — no CSV o
`product_id` é o id do checkout pai (ex.: `5171`/`4852`) e se repete nos order bumps, então NÃO
distingue OB de principal. Match por substring (lowercase):

| Produto | match em product_name | themembers (product_id) | Unnichat (tag_id) | Brevo (lista) |
|---|---|---|---|---|
| **Comunidade CNE** | `comunidade cne` | `443a9f54-4264-4fa4-b6b3-4d37eda6da19` | `019ecadb-f803-762c-8be0-8fe7f0f67250` | **#17** |
| **OB Negócios (CNT)** | `nova ordem tribut` | `d22226fa-468c-4aa4-907d-5ec3cf105212` | `019ecadb-cc61-7671-a40f-0f34bef0d846` | **#19** |
| **OB Acesso Vitalício** | `vital` (acesso vitalício) | **IGNORAR** (decisão do Tiago) | `019ecadb-b7c4-730d-be96-f9a9edfed4f0` | **#18** |
| **Workshop Soc.** | `workshop contratos societ` | `d459eb0f-808f-4538-a1aa-d65d598bb021` | `019dfc4c-6878-751b-874b-9e44d3eda864` | **#10** |
| **OB Pack Constituição** | `constitui` | `e4d0a577-05e9-42d2-8976-21a4c1ea30d9` | `019dfc4c…`(inscrito pago) + `019e3ec9-2117-726d-a038-c37adc001019` | **#10 + #15** |
| **OB Pack Estruturas** | `estruturas avan` ou `vesting` | `6390e1b3-8faa-4b52-8b6d-215d94b264ea` | `019dfc4c…`(inscrito pago) + `019e3ec9-461e-717e-bfd7-0d8dc2380f04` | **#10 + #14** |

**Regra dos packs (workshop):** quem compra um Pack (Constituição/Estruturas) via a oferta
"Workshop Societário AO VIVO" é tratado **também como Inscrito Pago do workshop** → recebe a tag
`019dfc4c` (Unnichat) e entra na **#10** (Brevo), além da tag/lista do pack específico. No
**themembers concede só o produto que ele comprou** (não conceda o workshop se ele não comprou).

**Nomes das listas Brevo (conferência):** #17 "[CNE] Comprou" · #19 "[CNE] OrderBump CNT" ·
#18 "[CNE] OrderBump Vitalício" · #10 "[WK-CSJUN26] Inscritos Pagos" · #15 "[WK-CSJUN26]
OrderBump_Constituição" · #14 "[WK-CSJUN26] OrderBump_Estruturas" · #9 "[WK-CSJUN26] Leads".

**themembers — períodos** (informativo; mandar só `accession_date`, a plataforma calcula a
expiração): Comunidade 730d · CNT 365d · Workshop 50d · Packs 100d. Todos `Venda única`, ativos.

---

## 1B) PERSISTIR NO GT — sistema de registro (binding por `provider · external_id`)

**TODA transação que o Tiago mandar (CSV ou chat) deve existir no GT — independente do status.**
Não é só PAID e não é só fallback: cada linha gera **lead** + o **evento que corresponde ao status**.
A maioria das vendas reais já chega via **webhook** (OnProfit/Guru → Edge) e já está no GT — então,
na prática, **conferir e persistir só o que falta** (idempotente). Persistir é data-only (sem dispatch).

**Status do CSV → como o GT modela** (o lead é SEMPRE criado/resolvido por email/telefone, em qualquer status):

| Status no CSV (OnProfit/Guru) | Evento no GT | Lifecycle | Notas |
|---|---|---|---|
| `PAID` / `approved` | `Purchase` | promove (`cliente`/`aluno`/… pela categoria do produto) | venda confirmada |
| `WAITING` / `pending` / aguardando pagamento | `InitiateCheckout` | sem promoção (fica `lead`) | intenção de compra (pix/boleto gerado) |
| carrinho abandonado / `cart_abandonment` / abandoned | `InitiateCheckout` | sem promoção (fica `lead`) | é assim que o GT guarda carrinho abandonado (não há entidade separada) |
| `REFUNDED` / `CANCELLED` / `chargeback` | lead permanece; **sem** `Purchase` (não criar aqui) | — | não enriquecer nos externos |

> O lead nasce/atualiza igual em qualquer status (`resolveLeadByAliases` por email→telefone, com
> merge/alias). A diferença é só o evento e a promoção de lifecycle. Eventos não-PAID **não** vão
> pros sistemas externos (§2).

**Mesmo lead em vários status (ex.: abandonou → pix `WAITING` → comprou `PAID`):**
- É **UM lead só** — os 3 status anexam ao mesmo `lead_id` (dedup por email→telefone). Os eventos
  **acumulam** no timeline (IC abandono + IC waiting + Purchase); idempotente por `event_id` (linha + status).
- **Lifecycle é monotônico** (`promote()` só sobe): fica `cliente` no PAID e **não regride** — independe
  da ordem das linhas no CSV. O lead vira **cliente**, NÃO fica "lead" e "cliente" ao mesmo tempo —
  o estado de lead/abandono vira **histórico** (preservado como eventos: dá pra segmentar "cliente que
  abandonou carrinho antes de comprar").
- **Recovery de carrinho é suprimida** se o lead já comprou (`recovery-sender` marca `suppressed`) —
  o evento de abandono permanece, só não dispara mensagem.
- **O que eu confiro manualmente:** se a linha do abandono/waiting tem **email diferente** da linha do
  PAID, o merge só ocorre se baterem por **telefone** — checar e, se preciso, garantir o alias/merge
  pra não ficar com lead duplicado (um "abandonado" órfão + um "cliente").

**Catálogo de produtos no GT (workspace `outsiders`)** — par `(provider, external_id)` é a chave canônica:

| Produto | OnProfit (`provider=onprofit`) | Guru (`provider=guru`) |
|---|---|---|
| **Workshop Contratos Societários** | `4852` | `1777982620` (+ `1777880037`) |
| **Pack Constituição e Sociedade** | `4853` | `1777982128` |
| **Pack Estruturas Avançadas** | `4854` | `1777983631` |
| **Comunidade CNE** | `5171` | `1747647500` |
| **Negócios na Nova Ordem Trib. (CNT)** | `5172` | — |
| **OB Acesso Vitalício** | `5173` | — |

> **OnProfit bundle CNE:** `5171`=Comunidade CNE (principal), `5172`=CNT, `5173`=Vitalício. CNT e
> Vitalício são vendidos como **order bump OU avulso**. No CSV o `product_id` pode vir como o
> checkout pai — distinguir o item por `product_name` e bindar no `external_id` certo acima.
> (Vitalício foi criado sem categoria no GT — definir no CP, pois `category` dirige a promoção de lifecycle.)

**Como resolver o produto do GT a partir de um CSV/lead (ordem obrigatória):**
1. **PROVIDER vem da origem.** Export OnProfit → `onprofit`; export Guru → `guru`. O `product_id`
   do CSV confirma o namespace: `4852/4853/4854/5171` = OnProfit; `1747…/1777…` = Guru.
2. **PRODUTO ESPECÍFICO vem do `product_name`** (o `product_id` do CSV é o checkout pai e se repete
   nos OBs — não serve pra distinguir).
3. **Binding = `(provider, external_id)`** da tabela acima. **NUNCA** atribua a venda a um produto de
   **outro** provider só porque o nome bate. (Foi esse o bug de 2026-06-17: o backfill carimbou
   1.748 vendas OnProfit nos produtos Guru de mesmo nome; corrigido por
   `scripts/maintenance/fix_onprofit_misattributed_to_guru.mjs`.)

**Passos por transação (qualquer status):**
1. **Resolver o lead** por email→telefone (`resolveLeadByAliases`) — cria/atualiza/merge. Vale pra
   PAID, pending, abandonado: o lead sempre entra/atualiza no GT.
2. **Determinar o evento** pela tabela de status acima (`Purchase` p/ PAID; `InitiateCheckout` p/
   pending/aguardando/abandonado; refund/cancel → sem evento de compra).
3. **Conferir se já existe no GT:** procurar o evento (`Purchase`/`InitiateCheckout`) do lead cujo
   `custom_data.product_db_id` = produto resolvido. Se existe → nada a fazer.
4. **Se não existe → inserir** (data-only, **sem dispatch** — não polui atribuição da escala ativa):
   evento com `event_source='webhook:<provider>'`, `custom_data.{product_id=external_id,
   product_db_id=<uuid>, product_name, amount, currency, backfill_source=<basename do csv>}`.
   Idempotente por `event_id` derivado do id da linha + status. Só PAID promove lifecycle.
   **Padrão de referência:** `apps/edge/scripts/backfill-clientes-workshop.ts` (`STATUS_MAP`:
   PAID→Purchase, WAITING→InitiateCheckout — estender o map p/ abandonado/pending de outros exports;
   já corrigido p/ `provider=onprofit`; bloqueado com `--force-rerun` pois NÃO deduplica vs webhook).
5. **Produto faltando no catálogo** (ex.: novo OB): **NÃO inventar id** — cadastrar o produto no GT
   primeiro (CP → Produtos, provider + external_id corretos) ou perguntar ao Tiago.

⚠️ **Não re-rodar backfill cegamente.** Se a venda já entrou por webhook, um insert por CSV **duplica**
(event_id do CSV ≠ event_id do webhook). Sempre conferir o passo 1 antes de inserir.

---

## 2) REGRAS GERAIS

- **Status:** o **GT recebe TODOS** os status (PAID→Purchase, pending/aguardando/abandonado→
  InitiateCheckout, sempre criando o lead — §1B). Os **3 sistemas externos** (themembers/Unnichat/
  Brevo) recebem **só `PAID`** — ignorar WAITING/CANCELLED/REFUNDED/abandonado lá.
- **Dedup:** por **email** (themembers/Brevo); por **telefone normalizado** (Unnichat).
- **`accession_date`** (themembers): data combinada no formato `YYYY-MM-DD` (ex.: data do
  lançamento; pergunte ao Tiago se incerto). Enviar **só** `accession_date`.
- Um comprador pode ter vários produtos → recebe os destinos de **cada** produto que comprou (PAID).
- CSVs costumam ser **cumulativos** (cada novo contém os anteriores). Pra "todos", use o mais recente.
- **Sempre normalizar o telefone** (algoritmo abaixo) antes de qualquer coisa.

---

## 3) NORMALIZAÇÃO DE TELEFONE (padrão GT — insere o "9")

Toda BR vira `+55` + DDD(2) + (9 se celular) + 8 dígitos. Regra do "9": local de 8 dígitos
começando em **6–9** = celular sem o 9 → insere o 9; começando em 2–5 = fixo, mantém. Outro país: passa cru.

```js
function normalizePhone(ddi, tel) {            // retorne +55... ; p/ Unnichat use só os dígitos (sem +)
  const d = `${ddi||''}${tel||''}`.replace(/\D/g,''); if (!d) return '';
  const rec = (dd,l) => (l.length===8 && /^[6-9]/.test(l) ? `+55${dd}9${l}` : `+55${dd}${l}`);
  if (d.startsWith('55')) { if (d.length===13) return `+${d}`; if (d.length===12){const r=d.slice(2); return rec(r.slice(0,2), r.slice(2));} return `+${d}`; }
  if (d.length===11) return `+55${d}`;
  if (d.length===10) return rec(d.slice(0,2), d.slice(2));
  return d.length>=11 ? `+${d}` : '';          // estrangeiro
}
```

---

## 4) ALGORITMO POR SISTEMA

### themembers  — `https://api.themembers.com.br/api/v1`  · `Authorization: Bearer <THEMEMBERS_API_TOKEN>`
Rate limit **300/min** → 429 com `error.retry_after` (segundos): honrar. 5xx = transitório (retry).
Por comprador, por produto (exceto Vitalício, que é ignorado aqui):
1. `GET /students/email/{email}` → 404? `GET /students/document/{cpf}` (fallback).
2. Não existe **e a busca não falhou** → `POST /students` `{first_name, email, last_name?, phone(+55), document(cpf), reference_id(cpf)}`.
   ⚠️ Se a busca deu **5xx persistente, NÃO crie** (evita aluno duplicado) — pule e reporte.
3. `GET /students/{id}/products` → já tem o `product_id`? Se não → `POST /students/{id}/products` `{product_id, accession_date}`.

### Unnichat  — `https://unnichat.com.br/api`  · header `Authorization: <UNNICHAT_API_KEY>` (a chave **já inclui** "Bearer ")
⚠️ **`name` E `phone` são obrigatórios** no create (sem nome → HTTP 400). ⚠️ **GET/search NÃO
retornam tags** — não dá pra verificar; confie no `{"success":true}` do POST. **search-first** (não
sobrescreve o nome de quem já existe). `POST /contact` é **upsert por telefone** (não duplica).
Por comprador:
1. `POST /contact/search` `{phone}` (dígitos) → existe `id`?
2. Não → `POST /contact` `{phone, name}` (sem nome no CSV → use **"Tudo Bem?"**).
3. Pra cada tag do(s) produto(s): `POST /contact/{id}/tags` `{tag_id}`. Se falhar, re-garanta o contato e re-tente.

### Brevo  — `https://api.brevo.com/v3`  · header `api-key: <BREVO_API_KEY>`
⚠️ **Forçar IPv4**: rode com `NODE_OPTIONS="--dns-result-order=ipv4first"` e/ou `curl -4` (o IPv6
residencial rotaciona e quebra). A restrição de **"Authorized IPs"** deve estar **OFF** no painel.
Import é **assíncrono** (retorna `processId`; aguarde `GET /v3/processes/{id}` ficar `completed`).
Por lista:
1. `POST /v3/contacts/import` `{ listIds:[N], updateExistingContacts:true, emptyContactsAttributes:false,
   jsonBody:[{ email, attributes:{ NOME, SOBRENOME, SMS:"+55..." } }] }`.
2. ⚠️ **Brevo dedup por telefone (SMS) também** → alguns são descartados. **Recover:** ler os emails
   da lista (`GET /v3/contacts/lists/{id}/contacts?limit=500&offset=`), achar os faltantes e re-importar
   **sem o campo SMS** (`emptyContactsAttributes:false` preserva o SMS já existente).

---

## 5) CREDENCIAIS (`.env.local`, gitignored)
- `THEMEMBERS_API_TOKEN` — token v1 (dashboard.themembers.com.br → Plataforma → Config → Tokens).
- `UNNICHAT_API_KEY` — já inclui o prefixo "Bearer ".
- `BREVO_API_KEY` — REST api-key v3 (✅ **já está no `.env.local`**; os scripts leem de lá. Ainda assim, rode os comandos Brevo com `NODE_OPTIONS="--dns-result-order=ipv4first"`).

---

## 6) SCRIPTS PRONTOS  (`scripts/maintenance/`, rodar com `node` da raiz do repo)
Todos aceitam `--csv <arquivo>` e são idempotentes (dry-run por padrão; `--apply` escreve).

| Script | O que faz |
|---|---|
| `themembers_enroll.mjs --csv X --apply` | matricula PAID (Comunidade/CNT/Workshop/Packs) no themembers |
| `tag_unnichat_comunidade.mjs --csv X --apply` | tag Comunidade `019ecadb-f803` |
| `tag_unnichat_obs.mjs --csv X --apply` | tags OB Negócios `019ecadb-cc61` / Vitalício `019ecadb-b7c4` |
| `brevo_import_comunidade.mjs --csv X --apply` | Comunidade → Brevo #17 (+recover) |
| `brevo_import_obs.mjs --csv X --apply` | Negócios → #19, Vitalício → #18 (+recover) |
| `reconcile_novos_agora.mjs` (lê `--csv` e baseline) | RELATÓRIO read-only do que falta em cada sistema |
| `tag_unnichat_clientes.mjs --csv X --apply [--products-only]` | tags workshop/packs (`019dfc4c`/`019e3ec9-*`) |
| `export_brevo_segments.mjs --apply` | listas workshop #9/#10/#14/#15 (a partir do DB GT) |

**Comandos Brevo:** a chave já está no `.env.local`; basta prefixar com `export NODE_OPTIONS="--dns-result-order=ipv4first"` (IPv4 estável).

---

## 7) FLUXO RECOMENDADO ao receber lista nova
1. Inspecionar o CSV (formato, `status`, `product_name`) e comparar com o anterior → **quem é novo**.
   Identificar o **provider** (origem OnProfit/Guru + namespace do `product_id`).
2. **GT primeiro (§1B), TODOS os status:** pra cada linha — resolver o lead (sempre) + o evento pelo
   status (PAID→Purchase, pending/aguardando/abandonado→InitiateCheckout), atribuído ao produto por
   `(provider, external_id)`. Conferir o que já existe (webhook) e persistir só o que falta (data-only,
   sem dispatch). Flag produto sem cadastro no GT — **não inventar id**.
3. Rodar `reconcile_*` (read-only) → relatório de lacunas por sistema externo; **mostrar ao Tiago**.
4. Executar os scripts `--apply` correspondentes aos produtos presentes (themembers → Unnichat → Brevo).
5. **Verificar:** GT (Purchase no produto certo, provider certo), themembers (grants novos/erros),
   Brevo (total da lista == esperado, recover se faltou), Unnichat (não dá pra ler tags → conferir
   0 erros + inferir "novos" vs baseline).
6. Reportar fechamento. Flag qualquer produto **sem destino mapeado** (não invente — pergunte os IDs).

## 8) LEAD AVULSO `{nome, email, telefone, produto}` (+ status, se houver)
Mesmo algoritmo, 1 contato: normalize o telefone → **(GT §1B)** resolva `(provider, external_id)`,
resolva/atualize o lead **sempre**, e persista o evento pelo status (PAID→Purchase; pending/aguardando/
abandonado→InitiateCheckout) se faltar → **só se PAID**: mapeie o produto na tabela §1 e propague →
themembers (find/create + grant) + Unnichat (search/create + tag) + Brevo (import + recover).
Se o produto/provider/status não estiver claro, **pergunte** (não assuma o provider pelo nome).

## 9) GOTCHAS (aprendidos)
- **O id do produto guia o PROVIDER.** Mesmo nome existe em providers diferentes (workshop/packs
  em `onprofit` E `guru`). Binding no GT = `(provider, external_id)`, **nunca só por nome** — senão
  vende no produto errado (incidente 2026-06-17, vide §1B). Para destinos externos, nome basta.
- **product_id do CSV é enganoso** (id do checkout pai, ex. `4852`/`5171`) → distingue só o
  **provider/checkout**, não o OB. Para o produto específico, casar por `product_name`.
- **Persistir no GT é data-only e SEM dispatch**; conferir se já existe (webhook) antes de inserir,
  senão duplica (event_id do CSV ≠ event_id do webhook).
- **Catálogo OnProfit do CNE (criado 2026-06-17):** `5171`=Comunidade CNE, `5172`=CNT,
  `5173`=Vitalício. (Antes `5171` estava rotulado como CNT — corrigido; tinha 0 vendas.) Se aparecer
  produto novo sem cadastro no GT, **cadastrar antes de linkar — não inventar id**.
- **Unnichat:** name obrigatório no create; não lê tags de volta; upsert por telefone.
- **Brevo:** dedup por telefone (recover sem SMS); IPv4 obrigatório; IP allowlist OFF.
- **themembers:** muitos compradores já vêm ativados por integração automática (OnProfit→themembers);
  o enroll só preenche lacunas. GET 5xx é transitório (retry, não criar duplicado).
- **CSV statuses:** GT persiste **todos** (PAID→Purchase, pending/aguardando/abandonado→
  InitiateCheckout, sempre com lead); externos só PAID. `data` é `DD/MM/YYYY HH:MM:SS` (BRT).
