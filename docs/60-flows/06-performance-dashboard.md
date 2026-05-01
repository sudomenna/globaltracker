# FLOW-06 — Dashboard de performance

## Gatilho
MARKETER abre Metabase ou dashboard custom para acompanhar lançamento.

## Atores
PERSONA-MARKETER, sistema (views/rollups), Metabase.

## UC envolvidos
UC-006.

## MOD-* atravessados
`MOD-EVENT` (consumido), `MOD-COST` (consumido), `MOD-AUDIENCE` (health), `MOD-DISPATCH` (health).

## CONTRACT-* envolvidos
View definitions em `packages/db/src/views.sql` + `30-contracts/02-db-schema-conventions.md` (ADR-018).

## BRs aplicadas
RNF-008 (escalabilidade analítica), ADR-018 (Metabase consume views).

## Fluxo principal

1. MARKETER autentica em Metabase (separado do Control Plane). Permissão por workspace via Metabase native ACL.
2. MARKETER abre dashboard "Performance Lançamento Março 2026".
3. Dashboard tem 6 painéis primários consultando views:

   - **Funil**: `daily_funnel_rollup` filtrado por `launch_id=L`. Mostra visit → lead → qualified → purchase com taxas de conversão entre etapas.
   - **CPL/CPA por anúncio**: `ad_performance_rollup` com join entre `ad_spend_daily.spend_cents_normalized` e atribuições + conversões. Granularidade `ad_id`.
   - **ROAS**: `(receita_normalized / spend_cents_normalized) × 100`, agregado por canal.
   - **ICP%**: `lead_icp_scores where is_icp=true / total leads`.
   - **Audience health**: `audience_health_view` com sync status, match rate (quando disponível), última sync.
   - **Dispatch health**: `dispatch_health_view` com taxa de sucesso por destino, DLQ size, erros recentes.

4. Queries Metabase consultam **apenas views/rollups**; nunca `events` bruto (RNF-008).
5. Rollups são refreshed por CF Cron (ex.: `daily_funnel_rollup` recompute às 02:00 UTC; freshness < 25h).
6. Dashboard mostra "Última atualização" baseado em metadata da view.
7. MARKETER navega painéis, filtros (date range, campaign, channel) aplicados em runtime.

## Fluxos alternativos

### A1 — Rollup atrasado / freshness ruim

5'. Cron de refresh falhou ou está atrasado:
   - Dashboard mostra warning "Última atualização há 36h — possível atraso de refresh".
   - Métrica `rollup_freshness_seconds{view}` ultrapassa SLA → alerta OPERATOR.

### A2 — Cost ingestor falhou

3'. `ad_spend_daily` sem dados para últimos N dias:
   - Painel CPL/CPA mostra "N/A" para esses dias com tooltip explicando.
   - `dispatch_health_view` em modo técnico mostra falha do cron.
   - OPERATOR investiga.

### A3 — Marketer tenta consulta SQL custom

3''. MARKETER com permissão SQL aberta tenta `SELECT * FROM events WHERE ...`:
   - Metabase tem ACL configurado para `events` apenas-leitura por OPERATOR.
   - MARKETER recebe permission denied.
   - Recomendação: criar rollup novo se métrica não existe.

### A4 — Workspace owner solicita audit

3'''. OWNER abre `audit_log_view`:
   - Vê lista filtrada por workspace (RLS via Metabase setting).
   - Pode filtrar por action, entity_type, ts.

## Pós-condições

- Dashboard renderizado com dados consistentes (até a última refresh).
- Métricas operacionais visíveis para correção rápida.
- Sem impacto em ingestion (queries em rollup, não em hot tables).

## TE-* emitidos

(Nenhum — dashboard é leitura.)

## Casos de teste

Dashboard não tem teste E2E direto, mas:
1. **View test**: queries de cada view retornam dados corretos para fixture.
2. **Refresh test**: cron de refresh atualiza materialized view dentro de SLA.
3. **Permission test**: VIEWER role não consegue acessar `events` raw.
4. **Freshness alerta**: simular cron parado por 26h e verificar que alerta dispara.
