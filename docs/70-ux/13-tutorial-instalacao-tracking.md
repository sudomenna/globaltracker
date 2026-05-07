# Tutorial: Instalação do Tracking no GlobalTracker

Este guia te leva passo a passo pela configuração completa de rastreamento de uma landing page no GlobalTracker. Ao final, você terá:

- Tracker do GlobalTracker enviando eventos ao Edge
- Google Analytics 4 (GA4) funcionando com Measurement Protocol
- Meta Pixel + Conversions API (CAPI) funcionando com deduplicação
- Cache do WP Rocket configurado para não bloquear nenhum dos scripts

---

## 1. Pré-requisitos

Antes de começar, você precisa:

1. **Acesso ao painel do GlobalTracker** — onde a launch e a page foram cadastradas
2. **Conta Google Analytics 4 (GA4)** — propriedade criada
3. **Conta Meta Business Manager** — Pixel criado em "Conjuntos de dados"
4. **Acesso de administrador ao WordPress** da landing page
5. **WP Rocket instalado** (ou outro plugin de cache — os passos podem variar)
6. **Plugin WPCode** (ou similar) para inserir scripts no `<head>`/footer

---

## 2. Coletar credenciais

Antes de tocar no WordPress, junte os IDs e tokens que vamos precisar:

### 2.1 GlobalTracker

No painel do GT, vá até a sua launch → page e copie os 3 valores que aparecem no snippet:

- `data-site-token` (ex: `4beab655...91a574093`)
- `data-launch-public-id` (ex: `wkshop-cs-jun26`)
- `data-page-public-id` (ex: `workshop`)

### 2.2 Google Analytics 4

1. Acesse [analytics.google.com](https://analytics.google.com) → **Administrador** → **Fluxos de dados**
2. Clique no fluxo do site que você está configurando
3. Anote o **ID da métrica** (formato `G-XXXXXXXXXX`)
4. Role até **"Chaves secretas da API do Measurement Protocol"** → **Criar** se não existir
5. Anote o **Valor do secret** (apelido sugerido: `GlobalTracker`)

### 2.3 Meta Pixel

1. Acesse [business.facebook.com/events_manager](https://business.facebook.com/events_manager)
2. Selecione o **Pixel** correspondente
3. Anote o **ID do Pixel** (15 ou 16 dígitos numéricos)
4. Em **Configurações** → **Tokens de acesso** → **Gerar token de acesso** se ainda não tiver
5. Anote o **Token de acesso** (string longa começando com `EAA...`)

### 2.4 Salvar no GlobalTracker

No painel do GT, vá em **Integrações**:

- **GA4**: cole o `Measurement ID` e a `API Secret`
- **Meta CAPI**: cole o `Pixel ID` e o `CAPI Token`

---

## 3. Instalar Google Analytics 4 na página

O GA4 precisa estar carregado na página para criar o cookie `_ga`, que o tracker do GlobalTracker lê e envia ao Measurement Protocol.

No WPCode, crie um snippet **JavaScript** com escopo "Cabeçalho em todo o site" (ou específico das páginas do funil):

```html
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

Substitua `G-XXXXXXXXXX` pelo seu Measurement ID em **ambos** os lugares.

---

## 4. Instalar Meta Pixel na página

O Pixel browser captura eventos client-side com o cookie `fbp`. Combinado com o CAPI server-side do GT, dá maior cobertura e melhor matching.

**Importante**: removemos a linha `fbq('track', 'PageView')` do snippet padrão do Meta porque o tracker do GT já dispara PageView server-side. Sem essa remoção, o evento iria duplicar.

No WPCode, crie um snippet **JavaScript** com escopo "Cabeçalho em todo o site", **depois** do gtag.js:

```html
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '<SEU_PIXEL_ID>');
</script>
<!-- End Meta Pixel Code -->
```

Substitua `<SEU_PIXEL_ID>` pelo ID numérico do seu Pixel.

---

## 5. Instalar tracker.js do GlobalTracker

O tracker.js é o arquivo principal: captura cookies, envia eventos ao Edge e expõe a API `window.Funil` para os snippets de evento.

No WPCode, crie um snippet **JavaScript** com escopo "Cabeçalho em todo o site", **depois** do GA4 e do Meta Pixel:

```html
<script
  src="https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js"
  data-site-token="<SEU_SITE_TOKEN>"
  data-launch-public-id="<SEU_LAUNCH_PUBLIC_ID>"
  data-page-public-id="<SEU_PAGE_PUBLIC_ID>"
  data-edge-url="https://globaltracker-edge.globaltracker.workers.dev"
  async
></script>
```

Substitua os 3 placeholders pelos valores que você coletou no passo 2.1.

---

## 6. Snippets de evento (footer)

Cada page do funil precisa de um snippet de "footer" que conecta ações específicas (clique em CTA, submit de formulário) ao tracker. Esse código deve ser inserido na **mesma page** onde o `<script src=tracker.js>` foi instalado, e precisa rodar **após** o tracker carregar.

No WPCode, crie um snippet **JavaScript** com escopo "Rodapé em todo o site" (ou Smart Conditional Logic apontando para a URL específica do funil).

Os snippets canônicos por tipo de page estão em `apps/tracker/snippets/paid-workshop/` no repositório:

- **`workshop.html`** — captura de lead (CTA + popup + form → POST /v1/lead → redirect Guru)
- **`obrigado-workshop.html`** — pós-checkout do workshop (resolve identidade + emite eventos custom)
- **`oferta-principal.html`** — oferta de upsell (ViewContent + click_buy_main)
- **`obrigado-principal.html`** — pós-checkout da oferta principal
- **`aula-workshop.html`** — page de aula (engajamento)

Copie o conteúdo apropriado, ajuste:

- IDs de elementos do Elementor (se diferentes)
- URL base do checkout (Guru, Hotmart, etc.)
- `consent` (deve ter as 5 finalidades como `'granted'` quando o usuário opta in via submit do form)

---

## 7. Configurar WP Rocket

WP Rocket é agressivo com lazy loading e minificação. Sem as exclusões corretas, ele vai atrasar ou cachear nossos scripts e quebrar o tracking.

### 7.1 Minificação

**Otimização de arquivo** → **JavaScript** → **Arquivos JavaScript Excluídos**:

```
tracker.js
connect.facebook.net/en_US/fbevents.js
```

Isso impede o WP Rocket de baixar e servir cópias minificadas locais — sempre carregamos do R2 (tracker) e do CDN da Meta (Pixel) com as versões mais novas.

### 7.2 Adiar carregamento (Defer JS)

**Otimização de arquivo** → **JavaScript** → "Adiar o carregamento do JavaScript" → **Arquivos JavaScript Excluídos**:

```
googletagmanager.com/gtag/js
pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js
gtag
tracker.js
connect.facebook.net/en_US/fbevents.js
```

### 7.3 Atrasar execução (Delay JS)

**Otimização de arquivo** → **JavaScript** → "Atrasa a execução do JavaScript" → **Arquivos JavaScript Excluídos**:

```
googletagmanager.com/gtag/js
pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js
gtag
tracker.js
connect.facebook.net/en_US/fbevents.js
```

> **Por que repetir a lista?** O WP Rocket tem 2 mecanismos diferentes (defer e delay) e cada um precisa da sua própria exclusão. Por que `gtag` aparece sem URL? Para excluir scripts inline que contêm a palavra `gtag` (ex: o `gtag('config', ...)` que cria o cookie `_ga`).

### 7.4 Salvar e limpar cache

Depois de aplicar as exclusões:

1. **Salvar Alterações** no fim de cada aba que você editou
2. Ir em **Dashboard** → clicar em:
   - **Esvaziar e Pré-carregar** (cache de página)
   - **Limpar** em "CSS Usado"
   - **Limpar** em "Elementos de Prioridade"

---

## 8. Validação

Abra a página em uma aba anônima e:

1. **Inspecione o HTML** (`Ctrl+U`) — verifique que **todos** os 3 scripts aparecem com `<script async src="..."></script>` (sem `type="rocketlazyloadscript"`)
2. **Abra o DevTools** (F12) → **Application** → **Cookies** — após alguns segundos deve aparecer:
   - `_ga` (do GA4)
   - `_ga_XXXXXXXXXX` (do GA4 stream)
   - `_fbp` (do Meta Pixel)
   - `__fvid` (do GlobalTracker)
3. **Console** — não deve ter erros vermelhos relacionados a `gtag`, `fbq`, ou `Funil`
4. **Aba Network** — filtre por `globaltracker-edge` — você deve ver:
   - `GET /v1/config/...` retornando 200
   - `POST /v1/events` para cada evento (PageView, click, Lead)

5. **Painel do GlobalTracker** — em "Eventos ao vivo" os eventos devem aparecer com:
   - `consent_analytics: granted`
   - `_ga` populado em `user_data`
   - `dispatch_jobs` succeeded para Meta CAPI e GA4 MP

6. **Painel do Meta Events Manager** → **Visão geral** — eventos chegando pelas duas fontes (Browser + Server)
7. **Painel do GA4** → **Tempo real** — usuários ativos visíveis

---

## 9. Troubleshooting comum

| Sintoma | Causa provável | Solução |
|---|---|---|
| `_ga` cookie não aparece no browser | gtag.js está sendo lazy-loaded pelo WP Rocket | Verificar exclusões em "Atrasar execução" e limpar cache |
| `dispatch:ga4_mp:skipped` com `no_client_id` | tracker.js carregou antes do gtag setar `_ga` | Inserir gtag.js **antes** do tracker.js no `<head>` |
| `dispatch:meta_capi:skipped` com `consent_denied:ad_user_data` | Snippet do form está enviando `consent: false` | Atualizar snippet com consent `'granted'` em todas as 5 finalidades |
| `dispatch:meta_capi:skipped` com `no_user_data` | Evento anônimo (sem lead, sem `fbp`/`fbc`) | Esperado quando Pixel não está instalado; instalar Pixel resolve via cookie `fbp` |
| Eventos duplicados no Meta Events Manager | Pixel disparando `PageView` automaticamente | Remover `fbq('track', 'PageView')` do snippet do Pixel |
| WP Rocket continua minificando o tracker.js | URL do R2 não está nas exclusões | Adicionar `tracker.js` (palavra-chave) nas 3 listas de exclusão |

---

## 10. Ordem dos scripts no `<head>`

A ordem importa. Sempre nesta sequência:

```
1. Google Analytics 4 (gtag.js + config inline)
2. Meta Pixel (fbq init, sem track PageView)
3. tracker.js do GlobalTracker
```

O motivo: tanto o GA4 quanto o Pixel precisam estar carregados quando o tracker capturar os cookies (`_ga`, `_fbp`). Se o tracker rodar antes, esses campos chegam null no payload e os despachos de GA4 MP falham com `no_client_id`.

---

## 11. Próximos passos / features futuras

- **Deduplicação Pixel + CAPI por `event_id` compartilhado** — requer pixel_policy `browser_and_server_managed` na launch + snippets emitindo `fbq('track', name, {}, { eventID: window.__funil_event_id })`. Hoje a dedup acontece via matching parameter overlap (suficiente em quase todos os casos)
- **`external_id` no payload Meta CAPI** — usar `__fvid` para aumentar match rate de eventos anônimos. Pendente de implementação
- **IP + user-agent no Meta CAPI** — pendente de revisão da BR-PRIVACY-001 (decisão de não armazenar)
