'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AlertTriangle, ArrowRight, Loader2, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

// ─── Auth hook (same as other pages) ─────────────────────────────────────────

function useAccessToken(): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        let raw = match[1];
        if (raw?.startsWith('base64-')) {
          raw = atob(raw.slice(7));
        } else if (raw) {
          raw = decodeURIComponent(raw);
        }
        if (raw) {
          const parsed = JSON.parse(raw) as { access_token?: string };
          setToken(parsed?.access_token ?? '');
        }
      } catch {
        setToken('');
      }
    }
  }, []);
  return token;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type LaunchStat = {
  public_id: string;
  name: string;
  status: string;
  leads: number;
  buyers: number;
  revenue: number;
};

type InboundWebhookHealth = {
  provider: 'guru' | 'onprofit' | 'sendflow' | 'hotmart' | 'kiwify' | 'stripe';
  last_received_at: string | null;
  minutes_since_last: number | null;
  count_1h: number;
  count_24h: number;
  state: 'ok' | 'warn' | 'down';
};

type DispatchHealthByDestination = {
  destination: string;
  total: number;
  succeeded: number;
  failed: number;
  dead_letter: number;
  success_rate: number | null;
  state: 'ok' | 'warn' | 'down';
};

type DashboardStats = {
  period: string;
  business: {
    revenue: number;
    buyers_unique: number;
    avg_ticket: number;
    conversion_rate: number;
  };
  funnel: {
    page_views: number;
    click_buy: number;
    leads: number;
    buyers: number;
  };
  tracking: {
    dispatch_success_rate: number | null;
    dead_letter_count: number;
    leads_with_fbclid_pct: number | null;
    leads_without_source_pct: number | null;
  };
  integrations: {
    inbound: InboundWebhookHealth[];
    outbound: DispatchHealthByDestination[];
  };
  roas: number | null;
  spend: number;
  avg_daily_spend: number | null;
  spend_coverage_days: number;
  period_days: number;
  ads_meta: {
    revenue: number;
    buyers_unique: number;
    roas: number | null;
    share_of_revenue: number | null;
    share_of_buyers: number | null;
  };
  launches: LaunchStat[];
};

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCurrency(value: number): string {
  if (value >= 1_000_000) return `R$ ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `R$ ${(value / 1_000).toFixed(1)}K`;
  return `R$ ${value.toFixed(2).replace('.', ',')}`;
}

function fmtPct(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function fmtRoas(value: number | null): string {
  if (value === null) return '—';
  return `${value.toFixed(2)}x`;
}

function fmtCount(n: number): string {
  return n.toLocaleString('pt-BR');
}

// ─── Period selector ──────────────────────────────────────────────────────────

const PERIODS = [
  { value: 'today', label: 'Hoje' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
] as const;

type Period = (typeof PERIODS)[number]['value'];

function PeriodSelector({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden text-sm">
      {PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onChange(p.value)}
          className={`px-3 py-1.5 transition-colors ${
            value === p.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:bg-accent'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  sub,
  alert,
  partial,
  partialTooltip,
}: {
  title: string;
  value: string;
  sub?: string;
  alert?: boolean;
  partial?: boolean;
  partialTooltip?: string;
}) {
  return (
    <Card className={alert ? 'border-destructive' : undefined}>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {alert && (
            <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
          )}
          {title}
          {partial && !alert && (
            <span
              className="ml-auto rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
              title={partialTooltip}
              aria-label={partialTooltip ?? 'Dados parciais'}
            >
              parcial
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold tabular-nums ${alert ? 'text-destructive' : ''}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Funnel row ───────────────────────────────────────────────────────────────

function FunnelStep({
  value,
  label,
  rate,
}: {
  value: number;
  label: string;
  rate?: number | null;
}) {
  return (
    <>
      <div className="text-center min-w-[72px]">
        <p className="text-xl font-bold tabular-nums">{fmtCount(value)}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </div>
      {rate !== undefined && (
        <div className="flex flex-col items-center text-muted-foreground min-w-[48px]">
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          <p className="text-xs tabular-nums">{rate == null ? '—' : fmtPct(Math.min(rate, 1))}</p>
        </div>
      )}
    </>
  );
}

function FunnelCard({
  pageViews,
  clickBuy,
  leads,
  buyers,
}: {
  pageViews: number;
  clickBuy: number;
  leads: number;
  buyers: number;
}) {
  const pvToClick = pageViews > 0 ? clickBuy / pageViews : null;
  const clickToLead = clickBuy > 0 ? leads / clickBuy : null;
  const leadToBuyer = leads > 0 ? buyers / leads : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Funil de conversão</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 flex-wrap">
          <FunnelStep value={pageViews} label="PageViews" rate={pvToClick} />
          <FunnelStep value={clickBuy} label="Click buy" rate={clickToLead} />
          <FunnelStep value={leads} label="Leads" rate={leadToBuyer} />
          <FunnelStep value={buyers} label="Compradores" />
        </div>

        {clickBuy > 0 && leads > clickBuy && (
          <p className="text-xs text-muted-foreground mt-3">
            Mais leads que clicks — possível captura por outros canais além da página workshop.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Launch table ─────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  live: 'Ao vivo',
  ended: 'Encerrado',
  configuring: 'Configurando',
  draft: 'Rascunho',
};

const STATUS_COLORS: Record<string, string> = {
  live: 'text-green-700 bg-green-100',
  ended: 'text-muted-foreground bg-muted',
  configuring: 'text-amber-700 bg-amber-100',
  draft: 'text-muted-foreground bg-muted',
};

function LaunchesTable({ data }: { data: LaunchStat[] }) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        Nenhum lançamento ativo no período.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="text-left py-2 pr-4 font-medium">Lançamento</th>
            <th className="text-right py-2 px-4 font-medium">Leads</th>
            <th className="text-right py-2 px-4 font-medium">Compradores</th>
            <th className="text-right py-2 px-4 font-medium">Conv.</th>
            <th className="text-right py-2 pl-4 font-medium">Faturamento</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {data.map((l) => {
            const conv = l.leads > 0 ? l.buyers / l.leads : 0;
            return (
              <tr key={l.public_id} className="hover:bg-accent/50 transition-colors">
                <td className="py-3 pr-4">
                  <Link
                    href={`/launches/${l.public_id}`}
                    className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    {l.name}
                  </Link>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="font-mono text-xs text-muted-foreground">{l.public_id}</span>
                    <span
                      className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${STATUS_COLORS[l.status] ?? ''}`}
                    >
                      {STATUS_LABELS[l.status] ?? l.status}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-4 text-right tabular-nums">{fmtCount(l.leads)}</td>
                <td className="py-3 px-4 text-right tabular-nums">{fmtCount(l.buyers)}</td>
                <td className="py-3 px-4 text-right tabular-nums text-muted-foreground">
                  {fmtPct(conv)}
                </td>
                <td className="py-3 pl-4 text-right tabular-nums font-medium">
                  {l.revenue > 0 ? fmtCurrency(l.revenue) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Integration health ──────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<InboundWebhookHealth['provider'], string> = {
  guru: 'Guru',
  onprofit: 'OnProfit',
  sendflow: 'SendFlow',
  hotmart: 'Hotmart',
  kiwify: 'Kiwify',
  stripe: 'Stripe',
};

const DESTINATION_LABELS: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  ga4_mp: 'GA4 MP',
  google_ads_conversion: 'Google Ads Conv.',
  google_enhancement: 'Google Enhanced',
  meta_audiences: 'Meta Audiences',
};

const STATE_STYLES: Record<'ok' | 'warn' | 'down', { dot: string; text: string }> = {
  ok: { dot: 'bg-green-500', text: 'text-green-700' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-700' },
  down: { dot: 'bg-red-500', text: 'text-red-700' },
};

function fmtTimeSince(minutes: number | null): string {
  if (minutes == null) return 'sem dados';
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin > 0 ? `há ${hours}h ${remMin}min` : `há ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

function HealthRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: 'ok' | 'warn' | 'down';
  detail: string;
}) {
  const style = STATE_STYLES[state];
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} aria-hidden="true" />
        <span className="font-medium truncate">{label}</span>
      </div>
      <span className={`text-xs tabular-nums ${state === 'ok' ? 'text-muted-foreground' : style.text}`}>
        {detail}
      </span>
    </div>
  );
}

function IntegrationsHealthCard({
  inbound,
  outbound,
}: {
  inbound: InboundWebhookHealth[];
  outbound: DispatchHealthByDestination[];
}) {
  const hasInbound = inbound.length > 0;
  const hasOutbound = outbound.length > 0;

  if (!hasInbound && !hasOutbound) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Saúde Integrações
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Nenhuma atividade nas últimas horas para mostrar.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Saúde Integrações
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasInbound && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Webhooks recebidos (inbound)
            </p>
            <div className="divide-y">
              {inbound.map((p) => (
                <HealthRow
                  key={p.provider}
                  label={PROVIDER_LABELS[p.provider] ?? p.provider}
                  state={p.state}
                  detail={`${fmtTimeSince(p.minutes_since_last)} · ${p.count_24h} em 24h`}
                />
              ))}
            </div>
          </div>
        )}

        {hasOutbound && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Dispatchers (outbound, 24h)
            </p>
            <div className="divide-y">
              {outbound.map((d) => (
                <HealthRow
                  key={d.destination}
                  label={DESTINATION_LABELS[d.destination] ?? d.destination}
                  state={d.state}
                  detail={`${d.success_rate != null ? fmtPct(d.success_rate) : '—'} · ${d.succeeded}/${d.total}${d.dead_letter > 0 ? ` · ${d.dead_letter} DLQ` : ''}`}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function IntegrationsBanner({ downCount }: { downCount: number }) {
  if (downCount === 0) return null;
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm flex items-start gap-2">
      <AlertTriangle
        className="h-4 w-4 text-destructive shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <div className="flex-1">
        <p className="font-medium text-destructive">
          {downCount === 1
            ? '1 integração está sem receber/enviar há mais de 6h'
            : `${downCount} integrações estão sem receber/enviar há mais de 6h`}
        </p>
        <p className="text-xs text-destructive/80 mt-0.5">
          Veja detalhes no card &quot;Saúde Integrações&quot; abaixo. Verifique
          status no provedor (Guru/OnProfit) ou rode{' '}
          <code className="font-mono text-xs">scripts/maintenance/webhook-smoke-test.sh</code>.
        </p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const accessToken = useAccessToken();
  const [period, setPeriod] = useState<Period>('7d');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(false);

    (async () => {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}/v1/dashboard/stats?period=${period}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!res.ok) throw new Error('non-ok');
        const body = (await res.json()) as DashboardStats;
        if (!cancelled) setStats(body);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [accessToken, period]);

  const { business, funnel, tracking, launches, integrations } = stats ?? {};

  // Funnel gap signal: pessoas chegando ao funil mas zero compradores.
  // Threshold deliberadamente baixo (5 leads) — em workspaces de baixo volume,
  // 5 leads + 0 compra já é sinal anômalo. Período relevante é o selecionado.
  const funnelGap =
    (funnel?.leads ?? 0) >= 5 && (funnel?.buyers ?? 0) === 0;

  // Banner global: quantas integrações estão "down" agora.
  const downCount =
    (integrations?.inbound?.filter((p) => p.state === 'down').length ?? 0) +
    (integrations?.outbound?.filter((d) => d.state === 'down').length ?? 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Visão geral do workspace</p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {loading && !stats && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Carregando métricas...
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Erro ao carregar métricas. Verifique se o Edge está acessível.
        </div>
      )}

      {stats && (
        <>
          {/* Banner global se algum integração está down */}
          <IntegrationsBanner downCount={downCount} />

          {/* Linha 1 — Negócio */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Negócio</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="Faturamento"
                value={fmtCurrency(business?.revenue ?? 0)}
                sub={
                  funnelGap
                    ? `${funnel?.leads ?? 0} leads no período sem nenhuma compra — checkout / webhook?`
                    : business?.buyers_unique
                      ? `${fmtCount(business.buyers_unique)} compradores únicos`
                      : undefined
                }
                alert={funnelGap}
              />
              {(() => {
                const isPartial =
                  period !== 'today' &&
                  stats.spend_coverage_days > 0 &&
                  stats.spend_coverage_days < stats.period_days;
                const partialTooltip = isPartial
                  ? `Investimento cobre ${stats.spend_coverage_days} de ${stats.period_days} dias do período (Meta começou a coletar em ${stats.spend_coverage_days >= stats.period_days ? '—' : 'data anterior à janela completa'}).`
                  : undefined;
                const partialSubInvest = isPartial
                  ? `${stats.spend_coverage_days}/${stats.period_days} dias cobertos${stats.avg_daily_spend != null ? ` · ${fmtCurrency(stats.avg_daily_spend)}/dia` : ''}`
                  : null;
                return (
                  <>
                    <KpiCard
                      title="Investimento"
                      value={fmtCurrency(stats.spend)}
                      partial={isPartial}
                      partialTooltip={partialTooltip}
                      sub={
                        partialSubInvest ??
                        (period === 'today'
                          ? stats.spend > 0 ? 'Hoje' : 'Sem dados de custo'
                          : stats.avg_daily_spend != null
                            ? `${fmtCurrency(stats.avg_daily_spend)}/dia`
                            : 'Sem dados de custo')
                      }
                    />
                    <KpiCard
                      title="Ticket médio"
                      value={fmtCurrency(business?.avg_ticket ?? 0)}
                      sub={`Conversão: ${fmtPct(business?.conversion_rate ?? 0)}`}
                    />
                    <KpiCard
                      title="ROAS"
                      value={fmtRoas(stats.roas)}
                      partial={isPartial}
                      partialTooltip={
                        isPartial
                          ? `ROAS calculado com spend incompleto (${stats.spend_coverage_days}/${stats.period_days} dias). Valor real provavelmente menor.`
                          : undefined
                      }
                      sub={
                        isPartial
                          ? `Spend ${stats.spend_coverage_days}/${stats.period_days} dias — valor real pode ser menor`
                          : stats.spend > 0
                            ? `${fmtCurrency(stats.spend)} investido`
                            : 'Sem dados de custo no período'
                      }
                    />
                  </>
                );
              })()}
            </div>
          </div>

          {/* Linha 1b — Atribuído a Anúncios (Meta) */}
          {stats.ads_meta && (
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Atribuído a Anúncios (Meta)
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Compradores com fbclid ou origem Meta/Instagram
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                  title="Faturamento Meta"
                  value={fmtCurrency(stats.ads_meta.revenue)}
                  sub={
                    stats.ads_meta.share_of_revenue != null
                      ? `${fmtPct(stats.ads_meta.share_of_revenue)} do faturamento total`
                      : 'Sem dados de atribuição'
                  }
                />
                <KpiCard
                  title="Compradores Meta"
                  value={fmtCount(stats.ads_meta.buyers_unique)}
                  sub={
                    stats.ads_meta.share_of_buyers != null
                      ? `${fmtPct(stats.ads_meta.share_of_buyers)} dos compradores únicos`
                      : 'Sem dados de atribuição'
                  }
                />
                <KpiCard
                  title="ROAS Meta"
                  value={fmtRoas(stats.ads_meta.roas)}
                  partial={
                    period !== 'today' &&
                    stats.spend_coverage_days > 0 &&
                    stats.spend_coverage_days < stats.period_days
                  }
                  partialTooltip={
                    stats.spend_coverage_days < stats.period_days
                      ? `ROAS Meta calculado com spend incompleto (${stats.spend_coverage_days}/${stats.period_days} dias).`
                      : undefined
                  }
                  sub={
                    stats.ads_meta.roas != null && stats.ads_meta.roas < 1
                      ? 'Abaixo do break-even (campanha deficitária)'
                      : stats.spend > 0
                        ? `Vs ROAS geral ${fmtRoas(stats.roas)}`
                        : 'Sem dados de custo'
                  }
                  alert={
                    stats.ads_meta.roas != null && stats.ads_meta.roas < 1
                  }
                />
                <KpiCard
                  title="Vendas não-Meta"
                  value={fmtCount(
                    (business?.buyers_unique ?? 0) - stats.ads_meta.buyers_unique,
                  )}
                  sub={
                    business?.buyers_unique
                      ? `${fmtPct(1 - (stats.ads_meta.share_of_buyers ?? 0))} dos compradores · orgânico, lista, indicação`
                      : 'Sem compradores no período'
                  }
                />
              </div>
            </div>
          )}

          {/* Linha 2 — Funil */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Funil</p>
            <FunnelCard
              pageViews={funnel?.page_views ?? 0}
              clickBuy={funnel?.click_buy ?? 0}
              leads={funnel?.leads ?? 0}
              buyers={funnel?.buyers ?? 0}
            />
          </div>

          {/* Linha 3 — Saúde do tracking */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Saúde do tracking</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                title="Sucesso de envios"
                value={fmtPct(tracking?.dispatch_success_rate ?? null)}
                sub="Dispatches concluídos"
              />
              <KpiCard
                title="Dead letters"
                value={fmtCount(tracking?.dead_letter_count ?? 0)}
                sub="Falhas permanentes"
                alert={(tracking?.dead_letter_count ?? 0) > 0}
              />
              <KpiCard
                title="Leads com fbclid"
                value={fmtPct(tracking?.leads_with_fbclid_pct ?? null)}
                sub="Cliques rastreáveis Meta"
              />
              <KpiCard
                title="Sem atribuição UTM"
                value={fmtPct(tracking?.leads_without_source_pct ?? null)}
                sub="Leads sem origem"
              />
            </div>
          </div>

          {/* Linha 4 — Saúde Integrações (inbound webhooks + outbound dispatchers) */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Saúde Integrações
            </p>
            <IntegrationsHealthCard
              inbound={integrations?.inbound ?? []}
              outbound={integrations?.outbound ?? []}
            />
          </div>

          {/* Linha 5 — Lançamentos */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" aria-hidden="true" />
                    Lançamentos
                  </CardTitle>
                  <CardDescription>
                    Por receita no período — ao vivo e encerrados recentemente
                  </CardDescription>
                </div>
                <Link
                  href="/launches"
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
                >
                  Ver todos
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <LaunchesTable data={launches ?? []} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
