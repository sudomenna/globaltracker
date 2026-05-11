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

type DashboardStats = {
  period: string;
  business: {
    revenue: number;
    buyers_unique: number;
    avg_ticket: number;
    conversion_rate: number;
  };
  funnel: {
    leads: number;
    initiate_checkout: number;
    buyers: number;
    lead_to_checkout_rate: number;
    checkout_to_buyer_rate: number;
  };
  tracking: {
    dispatch_success_rate: number | null;
    dead_letter_count: number;
    leads_with_fbclid_pct: number | null;
    leads_without_source_pct: number | null;
  };
  roas: number | null;
  spend: number;
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
}: {
  title: string;
  value: string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <Card className={alert ? 'border-destructive' : undefined}>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          {alert && (
            <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
          )}
          {title}
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

function FunnelCard({
  leads,
  ic,
  buyers,
  leadToIcRate,
  icToBuyerRate,
}: {
  leads: number;
  ic: number;
  buyers: number;
  leadToIcRate: number;
  icToBuyerRate: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Funil de conversão</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-center min-w-[72px]">
            <p className="text-xl font-bold tabular-nums">{fmtCount(leads)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Leads</p>
          </div>

          <div className="flex flex-col items-center text-muted-foreground min-w-[60px]">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            <p className="text-xs tabular-nums">{fmtPct(leadToIcRate)}</p>
          </div>

          <div className="text-center min-w-[72px]">
            <p className="text-xl font-bold tabular-nums">{fmtCount(ic)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Checkout</p>
          </div>

          <div className="flex flex-col items-center text-muted-foreground min-w-[60px]">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            <p className="text-xs tabular-nums">{fmtPct(icToBuyerRate)}</p>
          </div>

          <div className="text-center min-w-[72px]">
            <p className="text-xl font-bold tabular-nums">{fmtCount(buyers)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Compradores</p>
          </div>
        </div>

        {ic > 0 && buyers < ic && (
          <p className="text-xs text-muted-foreground mt-3">
            {fmtCount(ic - buyers)} pessoa{ic - buyers !== 1 ? 's' : ''} chegou{ic - buyers !== 1 ? 'aram' : ''} ao checkout mas não comprou{ic - buyers !== 1 ? 'aram' : ''} —{' '}
            potencial de retargeting.
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

  const { business, funnel, tracking, launches } = stats ?? {};

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
          {/* Linha 1 — Negócio */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Negócio</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <KpiCard
                title="Faturamento"
                value={fmtCurrency(business?.revenue ?? 0)}
                sub={business?.buyers_unique ? `${fmtCount(business.buyers_unique)} compradores únicos` : undefined}
              />
              <KpiCard
                title="Ticket médio"
                value={fmtCurrency(business?.avg_ticket ?? 0)}
                sub={`Conversão: ${fmtPct(business?.conversion_rate ?? 0)}`}
              />
              <KpiCard
                title="ROAS"
                value={fmtRoas(stats.roas)}
                sub={
                  stats.spend > 0
                    ? `Investimento: ${fmtCurrency(stats.spend)}`
                    : 'Sem dados de custo no período'
                }
              />
            </div>
          </div>

          {/* Linha 2 — Funil */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Funil</p>
            <FunnelCard
              leads={funnel?.leads ?? 0}
              ic={funnel?.initiate_checkout ?? 0}
              buyers={funnel?.buyers ?? 0}
              leadToIcRate={funnel?.lead_to_checkout_rate ?? 0}
              icToBuyerRate={funnel?.checkout_to_buyer_rate ?? 0}
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

          {/* Linha 4 — Lançamentos */}
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
