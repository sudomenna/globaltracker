# 12 — SCREEN: Live Event Console & Test Mode

> **Status:** Sprint 8 (depende de Supabase Realtime — fase 6+).
> Implementa itens E.1 + E.2 + E.3 do plano `ok-me-ajude-a-whimsical-key`.

## Propósito

Console em tempo real para observar eventos chegando ao GlobalTracker, com:
- **Stream ao vivo** de eventos com latência < 5s (E.1)
- **Toggle de modo teste** que faz dispatchers usarem `test_event_code` / `debug_mode` (E.2)
- **Replay de evento** para re-disparar como teste e diagnosticar (E.3)

Útil em três cenários:
1. **Pós-instalação**: "acabei de colar o snippet — está chegando?"
2. **Diagnóstico ativo**: "estou submetendo um form de teste e quero ver o pipeline"
3. **Validação de campanha**: "lançamento foi ar — eventos batem com expectativa?"

## Rotas

- `/launches/:launch_public_id/events/live` — escopo lançamento
- `/leads/live` — escopo workspace (todos os leads recentes)

Ambas exibem o mesmo console com filtros pré-aplicados.

## AUTHZ

- **Visualizar console:** OPERATOR, ADMIN, MARKETER
- **Toggle modo teste:** OPERATOR, ADMIN
- **Replay evento:** OPERATOR, ADMIN
- **Ver payload completo:** OPERATOR+ (MARKETER vê sanitizado)

---

## 1. Layout

```
Lançamento "Maio 2026" > Eventos ao vivo

┌─ Controles ──────────────────────────────────────────────┐
│ [⏸ Pausar]  [Modo teste: ●OFF]  [Limpar]                │
│                                                          │
│ Filtros:                                                 │
│   Page: [todos ▼]   Evento: [todos ▼]                    │
│   Status: [todos ▼]   Lead: [todos ▼]                    │
└──────────────────────────────────────────────────────────┘

┌─ Stream ─────────────────────────────────────────────────┐
│ ⏺ Conectado — recebendo eventos em tempo real            │
│                                                          │
│ 12:03:24  ✓ Lead       captura-v3   Meta✓  GA4✓  GAds✗   │
│           lp.cliente.com / ld_abc                        │
│           [Detalhes] [Replay como teste]                 │
│ ──────────────────────────────────────────────────────── │
│ 12:03:21  ✓ PageView   captura-v3   Meta⏸  GA4✓          │
│           lp.cliente.com                                 │
│           [Detalhes]                                     │
│ ──────────────────────────────────────────────────────── │
│ 12:03:18  ⚠ Lead       captura-v3   Meta⏸  GA4⏸          │
│           consent denied (ad_user_data)                  │
│           [Detalhes]                                     │
│ ──────────────────────────────────────────────────────── │
│ 12:03:15  ✓ PageView   home-v2      Meta⏸  GA4✓          │
│           lp.cliente.com                                 │
│           [Detalhes]                                     │
│                                                          │
│           ↑ ↑ ↑ (mais eventos chegam no topo)            │
└──────────────────────────────────────────────────────────┘

Eventos exibidos: últimos 100 (rolling window).
```

Cada linha tem:
- Timestamp local
- Status do evento (✓ accepted, ⚠ warning, ✗ rejected)
- Nome do evento
- Page identifier
- Resumo de dispatchers: Meta✓ GA4✓ GAds✗ (✓=succeeded, ⏸=skipped, ✗=failed, ⏳=pending)
- Lead public_id (clicável → timeline)
- Botões inline

---

## 2. Modo teste (E.2)

Toggle no header dos controles:

```
Modo teste: ●OFF  →  Modo teste: ●ON  (warning bg)
```

Quando **ON**:

```
┌─ ⚠️ Modo teste ATIVO ────────────────────────────────────┐
│ Eventos com user-agent X-GT-Test-Mode: 1 são tratados   │
│ como teste:                                              │
│   • Meta CAPI usa META_CAPI_TEST_EVENT_CODE              │
│   • GA4 MP usa debug_mode=1                              │
│   • Eventos NÃO contam para audiences nem dashboards     │
│                                                          │
│ Auto-desliga em: 56:42  [Desligar agora]                 │
└──────────────────────────────────────────────────────────┘
```

Stream filtra automaticamente para mostrar **apenas eventos com flag `is_test=true`**.

Implementação:
- Toggle escreve em `workspace_test_mode` (KV) com TTL 1h
- Edge inspeciona header `X-GT-Test-Mode: 1` ou cookie `__gt_test=1` em qualquer event ingest
- Marca `events.is_test = true`
- Dispatchers veem flag e usam credenciais/params de teste
- Console live filtra `is_test=true` quando modo teste está ativo

Como ativar do lado da LP:
- Botão na console: "Copiar URL de teste" → URL com `?_gt_test=1` que tracker detecta
- Ou chrome extension futura (fora de escopo)

---

## 3. Replay (E.3)

Em qualquer evento histórico no console, botão "Replay como teste":

```
┌─ Replay evento ──────────────────────────────────────────┐
│ Re-enviar este evento em modo teste?                     │
│                                                          │
│ Evento original:                                         │
│   Lead em captura-v3 (há 2h)                             │
│   Lead: ld_abc123                                        │
│   Falha original em Google Ads: gclid_not_found          │
│                                                          │
│ Replay vai:                                              │
│   ✓ Reenviar para Meta CAPI (test mode)                  │
│   ✓ Reenviar para GA4 MP (debug mode)                    │
│   ✓ Reenviar para Google Ads (test conversion)           │
│   • NÃO afeta dashboards de produto                      │
│                                                          │
│ Justificativa (audit log):                               │
│ [_______________________________________________]        │
│                                                          │
│             [Cancelar]   [Confirmar replay]              │
└──────────────────────────────────────────────────────────┘
```

Backend cria novo `dispatch_jobs` com `is_test=true`, `replayed_from_dispatch_job_id=...`.
Resultado aparece no console live com flag visual "REPLAY".

---

## 4. Detalhes inline (Detalhes)

Click em [Detalhes] expande a linha:

```
12:03:24  ✓ Lead       captura-v3   Meta✓  GA4✓  GAds✗
          ─────────────────────────────────────────
          event_id: evt_abc123
          recebido em: 12:03:24.127
          processado em: 12:03:24.892 (765ms lag)

          Dispatchers:
            ✓ Meta CAPI    340ms   evt match ✓
            ✓ GA4 MP       220ms   client_id mintado
            ✗ Google Ads   —       gclid_not_found

          [Ver lead na timeline →] [Ver no Meta ↗]
          [Replay como teste]
```

Não navega para outra tela — expansão inline. Para detalhes profundos, link "Ver lead na timeline".

---

## 5. Componentes shadcn

- `<Switch>` para toggle modo teste (com confirmação ao ligar/desligar)
- `<DropdownMenu>` para filtros
- Custom `<EventStream>` (lista virtualizada — usar TanStack Virtual)
- `<Collapsible>` para expandir detalhes
- `<AlertDialog>` para replay (destrutiva)
- `<Badge>` para status de cada dispatcher
- `<Toast>` (sonner) para confirmações de toggle/replay

---

## 6. Realtime (Supabase Realtime)

Ver [docs/10-architecture/05-realtime-jobs.md](../10-architecture/05-realtime-jobs.md) (atualizar para incluir realtime de UI).

Channel: `realtime:workspace:<workspace_id>:events`
Subscribe: `events` table com filter `workspace_id=eq.<id>`
Latência alvo: < 5s evento → display ([docs/70-ux/09-interaction-patterns.md:33-37](./09-interaction-patterns.md#L33-L37))

Cliente:
- Conecta ao montar a tela
- Desconecta ao desmontar OU ao clicar em Pausar
- Reconnect com backoff em caso de drop
- Indicador "⏺ Conectado" / "⏸ Pausado" / "⚠ Reconectando..." sempre visível

---

## 7. Performance

- Rolling window de 100 eventos (descarta os mais antigos)
- Lista virtualizada (TanStack Virtual) — render só do que está visível
- Throttle de updates: max 10 events/sec exibidos (eventos restantes ficam no buffer)
- "Carregar histórico" opcional — busca últimas 1000 rows via REST e mescla
- Pause não desconecta — só para de renderizar, mantém buffer

---

## 8. Estados

- **Conectando:** spinner + "Conectando ao stream..."
- **Conectado, sem eventos:** "Aguardando eventos. Submeta um form em sua LP para ver."
- **Conectado, recebendo:** stream rolando
- **Pausado:** ícone ⏸ + contador "47 eventos no buffer — clique em retomar"
- **Reconectando:** banner amarelo, mantém eventos já recebidos
- **Erro fatal:** "Conexão perdida — recarregue a página"

---

## 9. Endpoints consumidos

- `POST /v1/workspace/test-mode` — ativar/desativar modo teste (audit log)
- `GET /v1/workspace/test-mode` — verificar TTL restante
- `POST /v1/dispatch-jobs/:id/replay` — E.3
- `GET /v1/launches/:id/events?since=...` — histórico inicial (mesclar com realtime)
- WebSocket via Supabase Realtime — stream

---

## 10. A11y

- Stream com `aria-live="polite"` anuncia novos eventos quando relevantes (filtra para não anunciar todos os PageViews)
- Pausa atalho: `Space` ou `P`
- Cada linha navegável por teclado (arrow keys); Enter expande detalhes
- Toggle modo teste tem `aria-checked` + `aria-describedby` apontando para banner de aviso
- Indicador de conexão tem texto além do ícone

---

## 11. Test harness

- `tests/integration/control-plane/live-console-realtime.test.tsx` — mock Supabase channel + render
- `tests/integration/control-plane/live-console-test-mode.test.tsx` — toggle + flag em eventos
- `tests/integration/control-plane/live-console-replay.test.tsx` — E.3 + audit log
- `tests/load/live-console-throughput.test.ts` — 100 events/sec sustentado sem leak
- E2E: "Test mode ativado — submit em LP de staging aparece no console em < 5s"

---

## 12. Pré-requisitos de implementação

Antes do Sprint 8:
- [ ] Supabase Realtime configurado e validado em load test (Sprint 7?)
- [ ] `events.is_test boolean` adicionado ao schema (migration)
- [ ] `dispatch_jobs.replayed_from_dispatch_job_id uuid` adicionado
- [ ] Helpers `apps/edge/src/lib/test-mode.ts` para detectar header/cookie
- [ ] Atualização do middleware Edge para propagar test mode

---

## 13. Referências

- [02-information-architecture.md](./02-information-architecture.md) — rotas
- [09-interaction-patterns.md](./09-interaction-patterns.md) — realtime pattern
- [06-screen-lead-timeline.md](./06-screen-lead-timeline.md) — drill-down detalhado
- [10-architecture/05-realtime-jobs.md](../10-architecture/05-realtime-jobs.md) — infra realtime
- [50-business-rules/BR-DISPATCH.md](../50-business-rules/BR-DISPATCH.md) — replay/requeue
- [80-roadmap/08-sprint-8-ai-dashboard.md](../80-roadmap/08-sprint-8-ai-dashboard.md) — sprint
