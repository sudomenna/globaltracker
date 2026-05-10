/**
 * LeadSummaryHeader — Server Component (T-17-010)
 *
 * Renderiza o painel agregado, PII-free, do lead: jornada de stages, tags,
 * atribuição (first/last touch + click ids), consentimento atual e métricas.
 *
 * Fonte do shape: /v1/leads/:public_id/summary (apps/edge/src/lib/lead-summary.ts).
 *
 * BR-PRIVACY-001: este componente NUNCA renderiza email/phone/name — só
 * agregados e UTMs. PII fica acima, no header de identificação.
 * BR-RBAC: gating de "Identidade" é responsabilidade do page.tsx — aqui não há
 * informação sensível por papel.
 */

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tooltip } from '@/components/ui/tooltip';
import {
  Activity,
  Clock,
  Coins,
  Send,
  Shield,
  Tag,
} from 'lucide-react';
import type { LeadSummary } from './lead-summary-types';

interface LeadSummaryHeaderProps {
  summary: LeadSummary;
  role: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTimePtBR(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatRelativePtBR(iso: string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffSec = Math.round((then - now) / 1000);
    const abs = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
    if (abs < 60) return rtf.format(diffSec, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86400), 'day');
    if (abs < 31_536_000)
      return rtf.format(Math.round(diffSec / 2_592_000), 'month');
    return rtf.format(Math.round(diffSec / 31_536_000), 'year');
  } catch {
    return iso;
  }
}

function formatBrl(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

// ---------------------------------------------------------------------------
// JourneyStrip
// ---------------------------------------------------------------------------

function JourneyStrip({
  stages,
  current,
}: {
  stages: LeadSummary['stages_journey'];
  current: LeadSummary['current_stage'];
}) {
  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Sem stages registrados</p>
    );
  }

  const currentSince = current?.since ?? null;

  return (
    <nav aria-label="Jornada do lead" className="overflow-x-auto">
      <ol className="flex items-center gap-2 flex-wrap">
        {stages.map((s, idx) => {
          const isCurrent = currentSince
            ? s.at === currentSince && idx === stages.length - 1
            : idx === stages.length - 1;
          const isLast = idx === stages.length - 1;
          return (
            <li key={`${s.stage}-${s.at}`} className="flex items-center gap-2">
              <div
                className={
                  isCurrent
                    ? 'inline-flex flex-col items-start rounded-md border-2 border-primary bg-primary/10 px-2.5 py-1'
                    : 'inline-flex flex-col items-start rounded-md bg-muted px-2.5 py-1'
                }
              >
                <span
                  className={
                    isCurrent
                      ? 'text-xs font-semibold text-primary'
                      : 'text-xs font-medium text-foreground'
                  }
                >
                  {s.stage}
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatDateTimePtBR(s.at)}
                </span>
              </div>
              {!isLast && (
                <span className="text-muted-foreground" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// TagsPanel
// ---------------------------------------------------------------------------

function TagsPanel({ tags }: { tags: LeadSummary['tags'] }) {
  return (
    <Card>
      <section aria-label="Tags do lead">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Tag className="h-4 w-4" aria-hidden="true" />
            Tags
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          {tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sem tags atribuídas
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <Tooltip
                  key={`${t.tag_name}-${t.set_at}`}
                  content={`Definida por: ${t.set_by} • ${formatDateTimePtBR(t.set_at)}`}
                >
                  <Badge variant="secondary">#{t.tag_name}</Badge>
                </Tooltip>
              ))}
            </div>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ConsentPanel
// ---------------------------------------------------------------------------

const CONSENT_LABELS: Array<{
  key: keyof NonNullable<LeadSummary['consent_current']>;
  label: string;
}> = [
  { key: 'analytics', label: 'Analytics' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'ad_user_data', label: 'Ad user data' },
  { key: 'ad_personalization', label: 'Ad personalization' },
  { key: 'customer_match', label: 'Customer match' },
];

function ConsentPanel({
  consent,
}: {
  consent: LeadSummary['consent_current'];
}) {
  return (
    <Card>
      <section aria-label="Consentimento do lead">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4" aria-hidden="true" />
            Consentimento
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          {!consent ? (
            <p className="text-sm text-muted-foreground">
              Sem consentimento registrado
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {CONSENT_LABELS.map(({ key, label }) => {
                  const value = consent[key] as boolean;
                  return (
                    <Badge
                      key={key}
                      variant={value ? 'success' : 'outline'}
                      aria-label={`${label}: ${value ? 'concedido' : 'negado'}`}
                    >
                      {label}
                    </Badge>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Atualizado em {formatDateTimePtBR(consent.updated_at)}
              </p>
            </>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MetricsPanel
// ---------------------------------------------------------------------------

function dispatchesBadgeVariant(
  ok: number,
  failed: number,
  skipped: number,
): 'success' | 'warning' | 'destructive' | 'outline' {
  const total = ok + failed + skipped;
  if (total === 0) return 'outline';
  if (failed > 0) return 'destructive';
  if (skipped > 0) return 'warning';
  return 'success';
}

function MetricsPanel({ metrics }: { metrics: LeadSummary['metrics'] }) {
  const totalDispatches =
    metrics.dispatches_ok + metrics.dispatches_failed + metrics.dispatches_skipped;
  const dispatchVariant = dispatchesBadgeVariant(
    metrics.dispatches_ok,
    metrics.dispatches_failed,
    metrics.dispatches_skipped,
  );
  const dispatchVariantClass: Record<
    typeof dispatchVariant,
    string
  > = {
    success: 'text-green-700',
    warning: 'text-yellow-700',
    destructive: 'text-red-700',
    outline: 'text-foreground',
  };

  return (
    <section
      aria-label="Métricas do lead"
      className="grid grid-cols-2 md:grid-cols-4 gap-2"
    >
      {/* Eventos */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            Eventos
          </div>
          <p className="text-xl font-semibold mt-0.5">
            {metrics.events_total.toLocaleString('pt-BR')}
          </p>
        </CardContent>
      </Card>

      {/* Despachos */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Despachos
          </div>
          <p
            className={`text-xl font-semibold mt-0.5 ${dispatchVariantClass[dispatchVariant]}`}
          >
            {metrics.dispatches_ok}/{totalDispatches} OK
          </p>
        </CardContent>
      </Card>

      {/* Comprado */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Coins className="h-3.5 w-3.5" aria-hidden="true" />
            Comprado
          </div>
          <p className="text-xl font-semibold mt-0.5">
            {formatBrl(metrics.purchase_total_brl)}
          </p>
        </CardContent>
      </Card>

      {/* Última atividade */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Última atividade
          </div>
          {metrics.last_activity_at ? (
            <Tooltip content={formatDateTimePtBR(metrics.last_activity_at)}>
              <p className="text-sm font-medium mt-0.5">
                {formatRelativePtBR(metrics.last_activity_at)}
              </p>
            </Tooltip>
          ) : (
            <p className="text-sm text-muted-foreground mt-0.5">—</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main composition
// ---------------------------------------------------------------------------

export function LeadSummaryHeader({ summary, role: _role }: LeadSummaryHeaderProps) {
  return (
    <div className="space-y-3">
      {/* Linha 1 — JourneyStrip ocupa toda a largura */}
      <Card>
        <section aria-label="Jornada do lead (linha do tempo de stages)">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">Jornada</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <JourneyStrip
              stages={summary.stages_journey}
              current={summary.current_stage}
            />
          </CardContent>
        </section>
      </Card>

      {/* Linha 2 — Métricas (sempre full-width grid) */}
      <MetricsPanel metrics={summary.metrics} />

      {/* Linha 3 — grid 2 colunas (desktop) com Tags | Consent */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TagsPanel tags={summary.tags} />
        <ConsentPanel consent={summary.consent_current} />
      </div>
    </div>
  );
}
