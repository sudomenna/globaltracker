# 09 — Interaction patterns

> **Status:** skeleton. Detalhamento completo na Fase 4.

## Loading

- Skeleton screens (não spinners) para listas e dashboards.
- Spinner apenas para ações pontuais (form submit, delete).
- Timeout máximo: 10s — após, mostrar mensagem "Operação lenta — tente novamente".

## Empty states

Toda lista/painel vazio mostra:
- Ilustração discreta.
- Título claro ("Nenhum lançamento ainda").
- Call-to-action específico ("Criar primeiro lançamento").
- Link para docs/help quando aplicável.

## Erro

- **Erro de validação inline**: campo destacado vermelho + mensagem abaixo.
- **Erro de servidor**: toast destrutivo + opção de retry quando aplicável + correlation id (`X-Request-Id`) visível para suporte.
- **Erro de permissão**: mensagem específica ("Apenas Privacy ou Admin podem executar SAR") + link para docs.

## Confirmação destrutiva

Padrão para ações irreversíveis (SAR, archive workspace, revoke api_key):
1. Modal com explicação clara do impacto.
2. Campo de digitação exato ("Digite ERASE LEAD <id> para confirmar").
3. Botão destrutivo desabilitado até confirmação correta.
4. Após click: spinner + audit log entry visível em "Histórico" da entidade.

## Realtime (Fase 6+)

- Supabase Realtime para dashboard custom.
- Eventos de timeline aparecem em painel "Activity" (workspace ou launch).
- Latência alvo: < 5s do evento ao display.
- Console live detalhado em [12-screen-live-event-console.md](./12-screen-live-event-console.md).

## Polling status badge (Sprint 6)

Para validações curtas onde realtime é overkill (ex.: aguardar primeiro ping após instalar snippet):

- SWR/React Query com `refreshInterval` agressivo (5s) durante "estado pendente".
- Após transição para estado terminal (`healthy` ou `unhealthy`), reduzir para 60s.
- Timeout de 5min com mensagem clara: "Não recebemos resposta — verifique X".
- Componente `<HealthBadge>` ([07-component-health-badges.md](./07-component-health-badges.md)) padroniza visual.

## Drill-down em 3 níveis (Sprint 6)

Para observabilidade visual de saúde/eventos:

1. **Resumo agregado**: badge verde/amarelo/vermelho (sidebar, header).
2. **Lista de incidentes**: clique abre painel/tela com lista de problemas ativos com mensagens humanizadas (via [11-copy-deck-skip-messages.md](./11-copy-deck-skip-messages.md)).
3. **Detalhe + payload**: clique em incidente abre Sheet com payload sanitizado (AUTHZ-aware), correlation id, e ação (re-dispatch, deep-link externo).

Aplicado em: integration health, lead timeline, page status, workspace incidents panel.

## Contextual help (Sprint 6)

Padrão de 3 camadas (tooltip → glossário → painel "Por que isso aconteceu?") detalhado em
[08-pattern-contextual-help.md](./08-pattern-contextual-help.md).

## Forms

- React Hook Form + Zod resolver.
- Validação on-blur por default; on-change para campos críticos.
- Disable submit durante in-flight; reabilitar após response.
- Auto-save em rascunhos longos (`launches.config` builder).

## Tabelas

- Sortável por coluna.
- Paginação cursor-based (não offset — Postgres performance).
- Filtros declarativos no topo.
- Export CSV restrito a roles admin/operator (audit log entry obrigatória).

## Ações em massa (Fase 4+)

- Selecionar múltiplos via checkbox.
- Bulk action menu com confirmação.
- Limite de 100 por ação para evitar timeout (paginar se mais).

## Mobile / responsivo

Control Plane é desktop-first (operadores trabalham em monitor grande). Mobile read-only para dashboards quando essencial. Sem mobile app planejado.
