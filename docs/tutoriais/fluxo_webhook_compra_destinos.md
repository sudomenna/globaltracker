# Fluxo de Compra: Do Webhook aos Destinos de Tráfego (Meta, GA4, GAds)

**Resumo:**
Este documento explica como o GlobalTracker processa o dado de uma compra vinda de um webhook externo (ex: Digital Manager Guru) e distribui esse dado para múltiplas plataformas de anúncios (Meta Ads, Google Analytics 4 e Google Ads). O sistema atua de forma assíncrona e em paralelo, recebendo o webhook, normalizando a transação, associando ao Lead e criando trabalhos de despacho (Dispatch Jobs) independentes para cada destino. O documento também detalha o robusto mecanismo de tentativa e fila de erros (Retry e DLQ) que garante a resiliência dos dados.

---

## Fase 1: Recepção e Aceite Rápido (Inbound)
1. **O Webhook bate no Edge:** O provedor externo (como Hotmart ou Guru) dispara um `POST /v1/webhook/guru` informando uma transação (`webhook_type: "transaction"`, `status: "approved"`).
2. **Autenticação:** O Edge procura o token de segurança (ex: `api_token`) direto no corpo da requisição e valida de forma segura contra o banco de dados.
3. **Idempotência (Proteção anti-duplicidade):** O sistema gera um `event_id` único via hash matemático. Isso garante que, se o provedor enviar a mesma compra duas vezes por erro, o sistema ignorará a segunda.
4. **Fast Accept:** Para evitar falhas por tempo de resposta (*timeout*), o Edge salva o dado original de forma "crua" na tabela `raw_events`, joga numa Fila e devolve um `202 Accepted` de forma quase instantânea para a plataforma externa.

## Fase 2: O Cérebro (Normalização e Identidade)
Um processo de servidor interno ("Worker") consome o evento da fila:
5. **Mapeamento Canônico:** Uma função específica mapeia e transforma o formato da plataforma externa no evento padronizado interno do sistema: o **`Purchase`** (Compra). Além disso, converte valores monetários corretamente.
6. **Associação do Lead:** O sistema procura quem é o dono daquela compra, usando primeiro parâmetros customizados da origem, depois o Hash do Email ou do Telefone. Se o Lead não for encontrado, ele cria um novo no banco com as informações pessoais (PII) fortemente criptografadas, seguindo os princípios de *Privacy by Design*.

## Fase 3: Distribuição Paralela (Dispatch)
O sistema constrói a linha do tempo de atribuição (primeiro e último clique) e gera **Dispatch Jobs** (Tarefas de Envio) isoladas para cada destino elegível. A partir daqui, cada plataforma recebe o dado **em paralelo**, sem esperar pelas outras:

* **Para o Meta Ads Server (Meta CAPI):** O Job do Meta pega o evento `Purchase`, anexa o email/telefone do Lead já transformado em hash SHA-256 (regra obrigatória da Meta), adiciona cookies prévios (`fbclid`, `fbp`) e envia via Server-to-Server para a API de Conversões.
* **Para o GA4 (Measurement Protocol):** Outro Job monta a requisição formatada para o Google Analytics 4, enviando o evento `Purchase` junto com as UTMs de origem da conversão.
* **Para o Google Ads (Conversion Upload):** Um terceiro Job utiliza o clique registrado do Google (`gclid`) ou os dados de conversões aprimoradas para informar ao GAds que aquela campanha gerou uma venda real.

### Diferencial da Arquitetura: Retry e DLQ
Se alguma API externa (ex: Meta) sair do ar ou aplicar restrição de requisições (Erro 429), **os envios para o GA4 e GAds não são afetados**. Apenas a tarefa do Meta entrará em estado de `retrying` e fará até 5 novas tentativas (com intervalos maiores a cada vez). Se todas as 5 falharem, a tarefa cai numa Fila de Erros Irrecuperáveis (Dead Letter Queue - DLQ), permitindo que um operador revise e reenvie a conversão manualmente sem perder o faturamento.


Viewed CLAUDE.md:62-84
Viewed 03-sprint-3-meta-capi-webhooks.md:1-33
Viewed 13-digitalmanager-guru-webhook.md:1-181
Viewed 04-webhook-contracts.md:1-145
Viewed 08-mod-dispatch.md:1-140

Excelente pergunta. Com base nas especificações (especialmente no adaptador do Guru, nos contratos de webhooks e no módulo de dispatch), o fluxo é incrivelmente robusto. 

Vale um detalhe importante da arquitetura: o GlobalTracker **não manda os dados em "cascata"** (um esperando o outro). Como se trata de backend (Server-Side), assim que a compra é processada, ele notifica **Meta, GA4 e Google Ads em paralelo**, de forma assíncrona.

Aqui está o fluxo exato de como uma compra do Guru atravessa o sistema até chegar nessas plataformas:

### Fase 1: Recepção e Aceite Rápido (Inbound)
1. **O Webhook bate no Edge:** O Guru dispara um `POST /v1/webhook/guru` com um payload contendo `webhook_type: "transaction"` e `status: "approved"`.
2. **Autenticação:** O Edge procura o `api_token` direto no corpo do JSON (já que o Guru não usa HMAC) e compara com o banco de dados (`workspace_integrations`).
3. **Idempotência (Proteção anti-duplicidade):** O sistema gera um `event_id` único via hash (`sha256("guru:transaction:<id>:approved")`). Isso garante que se o Guru gaguejar e mandar a mesma compra duas vezes, o sistema ignora a segunda.
4. **Fast Accept:** Para o Guru não dar *timeout*, o Edge salva o dado original na tabela `raw_events`, joga numa Fila (CF Queue) e devolve um `202 Accepted` na mesma hora.

### Fase 2: O Cérebro (Normalização e Identidade)
Um "Worker" (Processador de Ingestão) consome o evento da fila:
5. **Mapeamento Canônico:** O `mapGuruTransactionToInternal()` entra em ação. Ele transforma aquele formato esquisito do Guru no evento padronizado do sistema: **`Purchase`** (Compra). Ele também converte o valor monetário que o Guru manda em centavos (ex: `29700` vira `R$ 297.00`).
6. **Associação do Lead:** O sistema procura de quem é aquela compra na seguinte ordem: Parâmetro customizado do Guru (`pptc`) -> Hash do Email -> Hash do Telefone. Se o Lead não existir, ele cria um novo no banco com o email/telefone **criptografados** (PII Encrypted).

### Fase 3: A Distribuição Paralela (Dispatch)
O Ingestion Processor constrói a atribuição (First-Touch/Last-Touch) e então gera **Dispatch Jobs** (Tarefas de Envio) isolados para cada destino elegível. A partir daqui, cada plataforma recebe o dado em paralelo:

* **Para o Meta Ads Server (Meta CAPI):** O `dispatch_job` do Meta pega o evento `Purchase`, anexa o email/telefone do Lead já hasheado em SHA-256 (regra do Meta), os parâmetros `fbclid`/`fbp` (se o usuário tinha cookie salvo na visita) e envia para a API de Conversões do Meta.
* **Para o GA4 (Measurement Protocol):** Outro job monta a requisição formatada para o Google Analytics 4, enviando o evento `Purchase` junto com as UTMs associadas àquela compra e o `client_id` original.
* **Para o Google Ads (Conversion Upload):** Um terceiro job pega os dados da compra e o `gclid` (ID de clique do Google), ou os dados em hash para o *Enhanced Conversions*, e comunica o Google Ads dizendo: *"O clique X que você gerou na campanha Y acabou de comprar"*.

**O grande diferencial da arquitetura (Sistema de DLQ e Retry):**
Se a API do Meta estiver fora do ar ou devolver um *Rate Limit* (Erro 429), o envio para o GA4 e para o Google Ads continua intacto e concluído. O job do Meta entrará no estado de `retrying` e fará até 5 tentativas espaçadas (com backoff exponencial). Se falhar nas 5, ele vai para uma "Dead Letter Queue" (DLQ) para não perder o dado de faturamento e permitir que o operador repita o envio manualmente depois.