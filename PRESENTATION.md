# Apresentação do Sistema: GlobalTracker

> Plataforma proprietária de **tracking inteligente, atribuição de tráfego e envio server-side** para Meta Ads, Google Ads, GA4 e plataformas de venda — pensada de ponta a ponta para a escala de Lançamentos de Infoprodutos.

---

## 1. O Cenário: Por que o modelo antigo quebrou?

Imagine um lançamento digital. Você investe R$ 100.000, R$ 500.000 ou até milhões em anúncios no Meta (Facebook/Instagram) e no Google Ads. O objetivo é atrair pessoas para uma Landing Page de captura, convencê-las a deixar o e-mail (virarem Leads) e, ao fim de algumas semanas, comprarem o seu produto em plataformas como Hotmart ou Digital Manager Guru.

Para que os algoritmos do Facebook e do Google funcionem bem e encontrem compradores baratos, eles precisam ser "alimentados" em tempo real. Eles precisam saber exatamente **quem se cadastrou** e **quem comprou**.

### O Pesadelo do Google Tag Manager (GTM)
Até então, o mercado resolvia isso com um amontoado de "gambiarras" através do Google Tag Manager. A cada novo lançamento, a equipe de tráfego precisava passar por um calvário:

1. **A Batalha dos Contêineres:** Criar um contêiner GTM para a Web (para rastrear a página) e um contêiner GTM Server-Side, hospedado no Google Cloud (para driblar os bloqueadores de anúncios e iOS 14 do lado do servidor).
2. **O Caos do Pixel e das Tags:** Entrar no GTM e criar dezenas de "Tags" e "Acionadores" manualmente para cada pequena ação. Se o desenvolvedor mudasse o código do botão da Landing Page, o rastreamento parava de funcionar sem ninguém perceber.
3. **Mapeamento Duplicado:** Configurar as variáveis no GTM Web para enviar ao GTM Server (usando tags improvisadas do GA4 como mensageiro), que então tentava "traduzir" isso para o Facebook. Era um telefone sem fio onde os dados frequentemente se perdiam.
4. **O Pesadelo da Desduplicação:** Para não contar o mesmo Lead duas vezes (uma pelo navegador e outra pelo servidor), era preciso gerar chaves complexas de desduplicação (`Event ID`). Se configurado errado, o Facebook contava 2.000 leads quando você só tinha 1.000.
5. **Sincronização de Públicos (Custom Audiences):** E para fazer remarketing nas campanhas? A equipe tinha que baixar um CSV da plataforma de vendas com milhares de e-mails e subir na mão no Gerenciador de Anúncios toda semana (ou depender de um N8N que sempre quebrava).

Resumo: **Configurar um lançamento levava dias, a manutenção era frágil e a inteligência dos dados sempre tinha furos.**

---

## 2. A Revolução: O que o GlobalTracker faz?

O **GlobalTracker** nasceu para exterminar o GTM e a dependência de configurações manuais e repetitivas. Nós construímos nossa própria "Central de Inteligência de Tráfego".

Em vez de amarrar 10 ferramentas diferentes com fita adesiva, o GlobalTracker unifica tudo de forma nativa e poderosa:

* **Instalação Única (O Rastreador invisível):** Em vez de configurar tags e acionadores complexos, você coloca **um único script (`tracker.js`)** no cabeçalho da Landing Page. Esse script pesa menos de 15kb e já sabe o que fazer sozinho. Ele intercepta as UTMs, coleta os cookies (`fbclid`, `gclid`) e envia os cadastros de forma silenciosa e segura para nossa API.
* **Sincronização Direta de Vendas:** O GlobalTracker é ligado diretamente à Hotmart e ao Guru via *Webhooks*. Quando uma compra cai, não dependemos do navegador do usuário dar um alerta. A plataforma de vendas avisa o nosso sistema em milissegundos.
* **O Despachante Automático (O Polvo):** Ao receber um Cadastro ou uma Compra, o nosso servidor atua como um "Polvo" com vários braços. Ele avisa o Meta CAPI, o Google Ads e o GA4 *simultaneamente*, enviando os dados já convertidos para o formato exato que cada plataforma exige.
* **Desduplicação Nativa ("Magia" Server-Side):** O sistema já gera as "senhas únicas" de eventos (`Event IDs`) sozinho e faz a coordenação entre a página e o servidor. O Facebook sempre recebe a informação limpa e 100% desduplicada.
* **Públicos no Automático:** Esqueça as planilhas CSV. O Lead entrou? O GlobalTracker avisa a API do Facebook instantaneamente para colocá-lo na audiência de remarketing correta de forma criptografada.

---

## 3. O Fluxo Perfeito: A Jornada de um Lead

Para ficar cristalino para quem não é de tecnologia, veja a jornada do sistema quando a sua campanha vai para o ar:

1. **O Clique:** O "João" está no Instagram e clica no seu anúncio de captação. O Facebook adiciona um código de rastro no link (`fbclid=123`).
2. **A Captura:** O João cai na sua Landing Page. O nosso `tracker.js` lê esse código e anota num caderninho digital no navegador do João. O João digita "joao@email.com" no formulário e clica em cadastrar.
3. **O Envio para a Central:** O script pega o e-mail e o código de rastro do João e manda direto para os nossos servidores de alta velocidade.
4. **O Aviso em Massa:** Nossos servidores criptografam o e-mail do João (transformando em um código legível apenas por máquinas por segurança) e enviam via CAPI (API) para o Facebook: *"Ei Facebook, aquele cara do código 123 virou um Lead."*
5. **A Compra (Dias Depois):** Duas semanas se passam, o João recebe um e-mail de vendas, clica e compra o seu curso no Digital Manager Guru. O João nem estava no mesmo computador do cadastro original!
6. **A Atribuição de Ouro:** O Guru avisa o GlobalTracker silenciosamente: *"O e-mail do João gerou uma compra"*. O GlobalTracker procura no nosso banco de dados, acha o João, vê que a origem dele lá no passado foi aquele anúncio específico, e avisa o Facebook e o Google: *"Lembra do João do anúncio X? Ele acabou de gerar R$ 997 de faturamento!"*.
7. **O Resultado Brilhante:** No seu Dashboard (Painel), aquele anúncio que parecia ter gerado apenas alguns leads baratos, agora mostra que tem um ROAS (Retorno) financeiro altíssimo. Os algoritmos das redes ficam mais inteligentes e passam a buscar mais pessoas iguais ao João para você.

---

## 4. Sob o Capô: Como funciona a Engenharia? (Para o Desenvolvedor Jr)

Se você é o desenvolvedor que vai dar manutenção ou evoluir essa plataforma, seja bem-vindo. O GlobalTracker é uma solução de **Event-Driven Architecture** (Arquitetura Orientada a Eventos) de alto calibre.

### A. A Stack de Alta Performance (Edge-First)
Nós usamos **Cloudflare Workers**. Em vez de alugar um servidor em uma única cidade (como na AWS ou Heroku), nosso código Backend (usando o framework HTTP `Hono`) roda na "borda" da internet (Edge), espalhado por data centers em todo o mundo. Isso garante latência de poucos milissegundos, evitando que a comunicação pesada atrase a Landing Page.

### B. O Banco de Dados (Postgres é o Rei Analítico)
O coração dos nossos relatórios é o **Postgres** (hospedado no Supabase), manipulado com **Drizzle ORM** e mantido hiper-rápido no Edge através do **Hyperdrive** (um gerenciador de pool de conexões da Cloudflare).
*Por que não um banco em tempo real como Convex ou Firebase?* Porque somos uma ferramenta de *Analytics* pura. Nós cruzamos relatórios financeiros, agrupamos campanhas e calculamos CPL (Custo por Lead) usando cláusulas pesadas de SQL. Bancos relacionais são imbatíveis para este cruzamento de dados.

### C. Resiliência Total (Filas e DLQ)
Para não perder dados vitais de faturamento se o Facebook sair do ar momentaneamente, não enviamos os eventos de forma síncrona na mesma requisição da web.
Nós jogamos os envios (Dispatch Jobs) em filas do **Cloudflare Queues**. Trabalhadores em segundo plano tentam o envio de forma isolada para cada plataforma. O Facebook deu "Rate Limit" (Erro 429)? O job entra em *retry* com atraso exponencial progressivo. Se falhar repetidas vezes, ele cai em uma gaveta de segurança chamada Fila de Falhas (Dead Letter Queue - DLQ), para reenvio manual posterior pela interface. Nenhuma compra se perde no limbo.

### D. Privacy by Design (A Regra de Ouro)
Manipular dados em alto volume exige responsabilidade rigorosa com a LGPD. Nosso banco não expõe e-mails. Dados de identificação pessoal (PII) são transformados em hash SHA-256 (como o Facebook exige) ou criptografados via algoritmo de nível militar `AES-256-GCM` na base. Para você (desenvolvedor ou administrador) descriptografar a informação, um log de auditoria registrará o seu acesso. Privacidade não é perfumaria, é a base.

---

## 5. Estrutura de Pastas e Stack Completa

| Camada | Tecnologia | Status |
|---|---|---|
| **Edge HTTP** | Cloudflare Workers + Hono | Sprint 1+ |
| **Database** | Postgres (Supabase) + Drizzle | Sprint 1+ |
| **Filas / Cache** | Cloudflare Queues + CF KV | Sprint 1+ |
| **Tracker JS** | Vanilla TS (Browser), < 15 KB | Sprint 2+ |
| **UI (Control Plane)** | Next.js 15 + shadcn/ui | Sprint 6+ |

### O Repositório:
```text
.
├── apps/
│   ├── edge/             # Backend das APIs (O cérebro na nuvem)
│   ├── tracker/          # Script inserido na Landing Page (O espião)
│   └── control-plane/    # Frontend e Dashboards de Análise (Next.js)
├── packages/
│   ├── shared/           # Schemas globais e Tipagens (Zod)
│   └── db/               # Configuração de Banco de Dados (Drizzle)
└── docs/                 # A Bíblia do Projeto (Regras e Fluxos Documentados)
```

---

## 6. Como rodar o projeto localmente (Setup do Dev)

Para subir o sistema na sua máquina, siga os passos abaixo:

1. **Dependências Primárias:** Instale Node.js (20 LTS), `pnpm` (nosso gerenciador de pacotes), Supabase CLI (para subir o banco de dados) e o Docker.
2. **Clone e instale:**
   ```bash
   git clone git@github.com:sudomenna/globaltracker.git
   cd globaltracker
   pnpm install
   ```
3. **Configure as credenciais (Variáveis):**
   Crie uma cópia do ambiente de desenvolvimento:
   ```bash
   cp apps/edge/.dev.vars.example apps/edge/.dev.vars
   ```
4. **Suba o Banco de Dados (Postgres Local):**
   ```bash
   supabase start
   pnpm db:push
   ```
5. **Rode a API (Worker) em modo Dev:**
   ```bash
   pnpm dev:edge
   ```
6. **Garanta a Integridade de Código:**
   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   ```
