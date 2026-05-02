# GTM Web + Server vs. Arquitetura Direta do GlobalTracker

**Resumo:**
Este documento contrasta a abordagem tradicional do Google Tag Manager (Web + Server), que usa o GA4 como um "mensageiro" para disparar eventos server-side (como o Meta CAPI), com a arquitetura do GlobalTracker. O GlobalTracker elimina o conceito de contêineres e variáveis duplicadas ao enviar o evento web através de um script dedicado (`tracker.js`) que conversa diretamente com o próprio backend via uma API canônica. O documento também esclarece como a desduplicação de eventos (Pixel vs. Server) é tratada nativamente pelo sistema através de geração unificada de IDs.

---

## O Problema do GTM Web + Server-Side
No modelo tradicional do Google Tag Manager:
- Você configura as Tags, Acionadores e Variáveis no container **Web**.
- Para acionar o Meta CAPI no lado do servidor, você normalmente usa uma Tag do GA4 como um "mensageiro" para enviar a informação via protocolo do Google até o seu container **Server**.
- No container Server, o GTM precisa extrair a informação que chegou formatada para GA4 e remapeá-la (através de mais Tags e Variáveis) para enviá-la para o Facebook.
- Esse processo gera um mapeamento duplicado de variáveis e depende da comunicação entre dois contêineres diferentes.

## Como o GlobalTracker resolve isso

A arquitetura do GlobalTracker é muito mais elegante e direta:

### 1. Comunicação Direta (O fim do "Mensageiro GA4")
No GlobalTracker, o script nativo da web (`tracker.js` — extremamente leve, < 15kb) fala a mesma língua do servidor.
Quando uma ação acontece na sua página, o script não precisa "fingir" que é um evento do GA4. Ele dispara uma requisição POST diretamente para a nossa API (`/v1/events` ou `/v1/lead`) enviando um payload de dados limpo, contendo parâmetros da página (UTMs), cookies de rastreio (`fbp`, `fbc`, `_gcl_au`) e dados do evento.

### 2. Um único Cérebro (Single Source of Truth)
A necessidade de gerenciar dois contêineres de variáveis acaba.
O evento entra uma única vez como um evento "canônico" (ex: `PageView`, `Lead`, `Purchase`) no nosso banco de dados. 
A partir daí, o módulo de despacho (`MOD-DISPATCH`) lê as configurações daquele Workspace e atua ativamente, traduzindo esse único evento canônico e espalhando-o para todas as plataformas ativadas de forma automática e em paralelo:
- Um Job traduz para o GA4 via Measurement Protocol.
- Outro Job traduz e aplica os hashes adequados para o Meta CAPI.
Não existe a necessidade de remapear variáveis de um container para outro repetidas vezes.

### 3. A Desduplicação Automática (Pixel + Server)
No ecossistema GTM, garantir que o disparo de um evento via Pixel do Navegador não se duplique com o mesmo evento enviado pelo Servidor pode ser um pesadelo: você precisa gerar variáveis próprias de *Event ID* e atrelar nas tags certas simultaneamente.

**No GlobalTracker, isso ocorre de forma orquestrada:**
O sistema possui uma política configurável chamada `browser_and_server_managed`. Quando ativa, o nosso script da página (`tracker.js`) gera um `event_id` único assim que o evento ocorre.
- Se houver um Pixel do Meta do lado do cliente ativado, esse `event_id` é enviado no disparo para o navegador.
- Ao mesmo tempo, ele transmite exatamente esse MESMO `event_id` para a nossa API do backend.
Quando o nosso backend for despachar esse evento via Server-Side (Meta CAPI), enviará o mesmo ID. O próprio Facebook entende (usando a janela de desduplicação de 48 horas) que se trata da mesma ação e evita duplicar os seus dados de conversão. Tudo isso "out-of-the-box".


Viewed 01-meta-capi.md:1-97
Viewed 04-integrations-canonical.md:1-135

Essa é uma dor clássica de quem escala tracking no GTM! O GTM Server-Side foi uma revolução, mas ele tem um design peculiar: ele foi construído em cima do ecossistema do Google. É por isso que você precisava usar a tag do GA4 ou do Universal Analytics como um "cavalo de Troia" (mensageiro) para transportar dados da web para o servidor, para só então "desempacotar" lá no GTM Server e mandar para o Meta CAPI.

O **GlobalTracker** resolve isso de forma muito mais elegante e direta, eliminando completamente a necessidade de "mensageiros", containers duplicados e mapeamento duplo de variáveis. Veja como isso é implementado na arquitetura:

### 1. Comunicação Direta (O fim do "Mensageiro GA4")
Em vez de usar uma tag do GA4 para transportar os dados, o nosso script da web (`tracker.js`) foi construído para falar a mesma língua do nosso servidor (Edge). 
Quando um evento acontece na sua Landing Page, o script dispara uma requisição POST direta (para a nossa rota `/v1/events` ou `/v1/lead`). Ele envia um payload (um JSON limpo) com as UTMs, cookies (`fbp`, `fbc`, etc) e os dados do formulário. Ele não finge ser o GA4; ele envia o evento "puro".

### 2. Um único "Contêiner" Central (Single Source of Truth)
No GTM, você precisa configurar um evento no container Web e depois configurar uma Tag no container Server para pegar aquele dado e mandar pro Meta.
No GlobalTracker, isso é centralizado no backend. O evento entra uma única vez como um evento "canônico" (ex: `Purchase` ou `Lead`). A partir daí, o módulo de despacho (`MOD-DISPATCH`) lê as configurações daquele Workspace e cria **trabalhos paralelos** de forma automática:
- O Dispatcher do GA4 transforma aquele evento interno num payload do Measurement Protocol.
- O Dispatcher do Meta (`apps/edge/src/dispatchers/meta-capi`) transforma o mesmo evento num payload do Meta CAPI (hasheando o email e telefone) e envia.
Tudo isso é gerenciado no servidor, sem que você precise mapear variáveis do lado web para o server repetidas vezes.

### 3. A Desduplicação Automática (O grande pesadelo do GTM)
No GTM, para mandar via Web (Pixel) e Server (CAPI) ao mesmo tempo, você tem que criar uma variável de `Event ID` no web, garantir que a Tag do Pixel do Meta e a Tag do GA4 mensageira usem exatamente essa mesma variável, para que o Meta saiba que é o mesmo evento. Se falhar, o Meta duplica seus leads.

**Como o GlobalTracker resolve isso:**
O sistema possui uma política interna chamada `browser_and_server_managed`. Quando configurada, o nosso script (`tracker.js`) gera o `event_id` no navegador. Se houver um Pixel do Meta do lado do cliente, ele já usa esse `event_id`. Ao mesmo tempo, ele envia esse MESMO `event_id` para o servidor (junto com os parâmetros `fbc` e `fbp`). 
A documentação do Meta CAPI do GlobalTracker (`40-integrations/01-meta-capi.md`) tem a seguinte regra:
> *Meta dedupe por event_name + event_id em janela de 48h. Sistema garante mesmo event_id em browser (Pixel) e server (CAPI).*

**Resumo:** Você troca dois contêineres e um "mensageiro adaptado" (GA4) por um único script leve (15kb) que fala nativamente com um backend robusto. O backend orquestra e distribui a informação para o Meta, Google Ads e GA4 em paralelo, garantindo a desduplicação por padrão!
