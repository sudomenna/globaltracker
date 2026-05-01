# 03 — SCREEN: Onboarding Wizard

> **Status:** Sprint 6. Implementa itens A.1 + A.2 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Conduzir MARKETER novo (workspace recém-criado) por configuração mínima funcional do GlobalTracker
**sem ler documentação técnica**. Cada passo é skippable mas o sistema sinaliza "Setup incompleto"
até conclusão.

Re-acessível via **Configurações → Onboarding** ou pelo banner de "Setup incompleto" no header.

## Rota

`/onboarding` (raiz, fora da sidebar normal). Redirect automático após login se `workspaces.onboarding_state.completed_at IS NULL`.

## AUTHZ

- **Acesso:** OWNER, ADMIN, MARKETER do workspace.
- **Skip total:** OWNER/ADMIN apenas (decisão consciente de "vou configurar via API").
- **Skip individual de passo:** todos.

---

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ Bem-vindo ao GlobalTracker                              [Pular] │
│                                                                  │
│ Vamos configurar seu workspace em 5 passos.                      │
│ Cada passo leva ~2 minutos.                                      │
│                                                                  │
│ ●━━━━━○━━━━━○━━━━━○━━━━━○                                        │
│ 1     2     3     4     5                                        │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ [conteúdo do passo atual]                                    ││
│ │                                                              ││
│ └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│              [← Voltar]  [Pular passo]  [Continuar →]            │
└──────────────────────────────────────────────────────────────────┘
```

Stepper visual no topo: passo atual sólido, futuros vazios, completados com ✓.

---

## 2. Passos

### 2.1 — [1/5] Conecte seu Meta Pixel

```
Conecte seu Meta Pixel

Para enviar eventos de conversão para o Meta Ads.

✅ Pré-requisito (faça no Meta antes de continuar):
   1. Verificar domínio da landing page no Meta Business Manager
      [Abrir Domain Verification ↗]
   2. Configurar priorização de eventos no Aggregated Event Measurement
      [Abrir AEM ↗]

📝 Cole as credenciais:
   Pixel ID:        [____________________]  ⓘ
   Token CAPI:      [____________________]  ⓘ  [Como gerar? ↗]
   Test Event Code: [____________________]  (opcional)

   ☐ Confirmo que verifiquei o domínio no Meta Business Manager
   ☐ Confirmo que priorizei eventos no AEM (iOS 14+)

   [Salvar e validar]
```

Ao clicar "Salvar e validar":
1. Frontend valida formato (Pixel ID = 15-16 dígitos, Token = string base64-like)
2. Backend faz `POST /v1/integrations/meta/test` (D.1) — dispara evento sintético com `test_event_code`
3. Resultado em ~3s:
   - ✓ "Conexão validada — evento de teste chegou no Meta Events Manager [Ver ↗]"
   - ✗ Erro contextualizado via [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md)

Persiste em `workspaces.config.tracking.meta` + `onboarding_state.step_meta = { completed_at, validated: bool }`.

### 2.2 — [2/5] Conecte seu Google Analytics 4

```
Conecte seu Google Analytics 4 (opcional)

Para enviar eventos analíticos ao GA4.

📝 Cole as credenciais:
   Measurement ID:  [G-____________]  ⓘ
   API Secret:      [____________________]  ⓘ  [Como gerar? ↗]

   ☐ Quero validar com debug_mode (recomendado)

   [Salvar e validar]   [Pular este passo]
```

Mesma lógica do passo 1: validate via `POST /v1/integrations/ga4/test`.

### 2.3 — [3/5] Crie seu primeiro Lançamento

```
Crie seu primeiro Lançamento

Um Lançamento agrupa landing pages, links e audiências de uma campanha.

📝 Dados:
   Nome:       [Lançamento Maio 2026__________]
   Public ID:  [lcm-maio-2026__________________]  (gerado automaticamente; editável)
   Status:     ◉ Draft  ○ Configuring  ○ Live

   [Criar lançamento]
```

Ao criar: redireciona para passo 4 com `launch_id` no contexto.

### 2.4 — [4/5] Registre sua Landing Page

```
Registre sua Landing Page

📝 Dados:
   Nome:              [Captura V1______________]
   Public ID:         [captura-v1______________]
   Domínio(s) permitidos:
   [+ lp.cliente.com________]
   [+ Adicionar outro]
   Modo:              ◉ Snippet (b_snippet)  ○ Server-to-server

📝 Eventos a capturar:
   ☑ PageView (automático ao carregar)
   ☑ Lead    (no submit do formulário)
   ☐ Custom (configurar depois)

   [Criar página]
```

Ao criar: gera `page_token` e avança ao passo 5 (instalação).

### 2.5 — [5/5] Instale o tracker e verifique

```
Instale o tracker

Cole o snippet abaixo no <head> da sua landing page.

⚠️ O token aparece apenas UMA vez — copie agora.

┌────────────────────────────────────────────────────────────────┐
│ <script                                                        │
│   src="https://cdn.globaltracker.com/tracker.js"               │
│   data-site-token="pk_live_abc123..."                          │
│   data-launch-public-id="lcm-maio-2026"                        │
│   data-page-public-id="captura-v1">                            │
│ </script>                                                      │
└────────────────────────────────────────────────────────────────┘
                                                  [📋 Copiar]

────────────────────────────────────────────────────────────────

Status:  ⏳ Aguardando primeiro ping... (12s)

         ↓ (quando chega)

Status:  ✅ Tracker instalado em lp.cliente.com
         Primeiro PageView recebido há 3s
         [Ver detalhes →]

         [Concluir onboarding] [Pular verificação]
```

Polling de `GET /v1/pages/:public_id/status` a cada 5s (timeout 5min).
Detalhes visuais do snippet em [04-screen-page-registration.md](./04-screen-page-registration.md).

---

## 3. Estados especiais

### 3.1 — Setup incompleto banner
Header global mostra banner discreto enquanto `onboarding_state.completed_at IS NULL`:

```
🟡 Setup incompleto — 2 de 5 passos pendentes  [Continuar →]
```

Click leva ao wizard com primeiro passo pendente.

### 3.2 — Skip total (OWNER/ADMIN apenas)
Modal com confirmação destrutiva ([09-interaction-patterns.md §4](./09-interaction-patterns.md)):

> Você pode configurar tudo via API ou voltar depois em Configurações → Onboarding.
> Tem certeza?
> [Cancelar] [Pular onboarding]

Marca `onboarding_state.skipped_at` (não `completed_at`). Banner muda para amarelo permanente.

### 3.3 — Validação Meta falha
Mensagens humanizadas via [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md), com botão de retry e botão "Salvar mesmo assim" (registra config sem validação — útil para staging).

### 3.4 — Volta ao wizard depois (re-entry)
Skipped ou completed pode re-entrar via Configurações → Onboarding. Mostra status atual de cada passo:
```
✓ [1/5] Meta Pixel — conectado
○ [2/5] GA4 — não configurado    [Configurar agora]
✓ [3/5] Lançamento — lcm-maio-2026
✓ [4/5] Página — captura-v1
○ [5/5] Verificar instalação      [Ir para snippet]
```

---

## 4. Componentes shadcn

- `<Stepper>` (custom — composição de `<Progress>` + ícones)
- `<Form>` + `<FormField>` (React Hook Form + Zod)
- `<Card>` para conteúdo do passo
- `<Button>` primary/secondary/ghost
- `<Tooltip>` em ícones ⓘ
- `<Alert>` para banner topo + erros validação
- `<Toast>` (sonner) para confirmações instantâneas
- `<HealthBadge>` ([07-component-health-badges.md](./07-component-health-badges.md)) para status do tracker no passo 5
- `<CodeBlock>` com botão copy para o snippet

---

## 5. Estados de loading/empty/error

- **Loading:** skeleton no card de passo (ex.: validando credenciais Meta = spinner inline no botão).
- **Empty:** N/A — onboarding sempre tem conteúdo.
- **Error:**
  - Validação inline ([09-interaction-patterns.md §3](./09-interaction-patterns.md))
  - Falha de validate Meta/GA4 → toast destrutivo + botão "Tentar novamente"
  - Falha de criar launch/page → mensagem específica + correlation id

---

## 6. Schema delta

```sql
-- packages/db/migrations/XXXX_workspace_onboarding_state.sql
ALTER TABLE workspaces ADD COLUMN onboarding_state JSONB NOT NULL DEFAULT '{}';
-- Estrutura esperada (sem schema enforcement em jsonb, mas Zod no app):
-- {
--   started_at: ISO8601,
--   completed_at: ISO8601 | null,
--   skipped_at: ISO8601 | null,
--   step_meta: { completed_at, validated },
--   step_ga4: { completed_at, validated },
--   step_launch: { completed_at, launch_id },
--   step_page: { completed_at, page_id },
--   step_install: { completed_at, first_ping_at }
-- }
```

---

## 7. Endpoints consumidos

- `GET /v1/onboarding/state` — retorna `onboarding_state` do workspace ativo
- `PATCH /v1/onboarding/state` — atualiza step
- `POST /v1/integrations/meta/test` — D.1
- `POST /v1/integrations/ga4/test` — D.1
- `POST /v1/launches` — criação
- `POST /v1/pages` — criação + retorna `page_token` (one-time)
- `GET /v1/pages/:public_id/status` — A.3 polling

---

## 8. A11y

- Stepper acessível: `aria-current="step"` no passo ativo, `aria-label` em cada step ("Passo 1 de 5: Meta Pixel — concluído").
- Validação inline com `aria-describedby` apontando para mensagem de erro.
- Botão "Pular" sempre acessível por teclado (não escondido em hover-only menu).
- Tooltips ⓘ disparáveis por focus, fecháveis por Escape.
- Snippet code block com `aria-label="Snippet de instalação"` + atalho de teclado para copiar.

---

## 9. Test harness

- `tests/integration/control-plane/onboarding-wizard.test.tsx` — fluxo end-to-end happy path
- `tests/integration/control-plane/onboarding-skip-resume.test.tsx` — skip + voltar re-popula estado
- `tests/integration/control-plane/onboarding-validate-fail.test.tsx` — Meta retorna erro → mensagem humanizada
- `tests/a11y/onboarding.test.tsx` — axe-core zero violations
- E2E ([docs/80-roadmap/98-test-matrix-by-sprint.md](../80-roadmap/98-test-matrix-by-sprint.md)): "MARKETER configura Meta CAPI via wizard e dispara teste com sucesso"

---

## 10. Referências

- [02-information-architecture.md](./02-information-architecture.md) — rota `/onboarding`
- [09-interaction-patterns.md](./09-interaction-patterns.md) — forms, error patterns
- [04-screen-page-registration.md](./04-screen-page-registration.md) — passo 5 (snippet vivo)
- [05-screen-integration-health.md](./05-screen-integration-health.md) — passos 1-2 (validação)
- [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md) — mensagens de erro
- [60-flows/01-register-lp-and-install-tracking.md](../60-flows/01-register-lp-and-install-tracking.md) — fluxo coberto pelo wizard
