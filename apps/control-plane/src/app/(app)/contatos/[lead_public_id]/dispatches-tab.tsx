'use client';

/**
 * dispatches-tab.tsx — Sprint 17 / T-17-016
 *
 * Technical "Despachos" tab for the lead detail page. Lists every dispatch_*
 * timeline node in tabular form with destination/status filters, payload
 * inspection, "Por que?" explainer, and re-dispatch action.
 *
 * Data source: shared `useTimeline()` hook scoped to dispatch_* node types.
 *
 * BR-DISPATCH: re-dispatch restricted to operator/admin (see RedispatchDialog).
 * BR-PRIVACY-001: response_code/error_code visible to operator/admin only.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  ChevronRight,
  HelpCircle,
  RefreshCw,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { RedispatchDialog } from './redispatch-dialog';
import {
  PERIOD_PRESETS,
  type NodeStatus,
  type NodeType,
  type PeriodPreset,
  type TimelineNode,
  useTimeline,
} from './use-timeline';
import { WhyFailedSheet } from './why-failed-sheet';

interface DispatchesTabProps {
  leadPublicId: string;
  role: string;
}

const DISPATCH_NODE_TYPES: NodeType[] = [
  'dispatch_queued',
  'dispatch_success',
  'dispatch_failed',
  'dispatch_skipped',
];

const STATUS_BADGE_VARIANT: Record<
  NodeStatus,
  'default' | 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'
> = {
  ok: 'success',
  failed: 'destructive',
  skipped: 'warning',
  pending: 'secondary',
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  ok: 'sucesso',
  failed: 'falha',
  skipped: 'ignorado',
  pending: 'pendente',
};

const DESTINATION_LABELS: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  ga4_mp: 'GA4 MP',
  google_ads_conversion: 'Google Ads',
  google_enhancement: 'Google (Enhanced)',
  audience_sync: 'Audience Sync',
};

function destinationLabel(d: string): string {
  return DESTINATION_LABELS[d] ?? d;
}

function getString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function getNumber(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' ? v : null;
}

interface RowProps {
  node: TimelineNode;
  role: string;
  onWhyFailed: (reason: string) => void;
  onRedispatch: (jobId: string) => void;
}

function DispatchRow({ node, role, onWhyFailed, onRedispatch }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const canRedispatch = role === 'operator' || role === 'admin';
  const isOperatorPlus = role === 'operator' || role === 'admin';

  const eventName =
    getString(node.payload, 'event_name') ??
    (node.label ? node.label : '—');
  const destinationKey =
    node.destination ?? getString(node.payload, 'destination') ?? '—';
  const destinationResourceId = getString(
    node.payload,
    'destination_resource_id',
  );
  const attemptCount =
    getNumber(node.payload, 'attempt_count') ??
    getNumber(node.payload, 'attempts') ??
    0;
  const responseCode = getNumber(node.payload, 'response_code');
  const errorCode = getString(node.payload, 'error_code');
  const ts = new Date(node.occurred_at).toLocaleString('pt-BR');
  const showWhy = node.status === 'failed' || node.status === 'skipped';

  return (
    <>
      <tr className="border-b">
        <td className="px-3 py-2 text-sm">{eventName}</td>
        <td className="px-3 py-2 text-sm">
          <div className="flex flex-col">
            <span>{destinationLabel(destinationKey)}</span>
            {destinationResourceId && (
              <span className="text-xs text-muted-foreground font-mono truncate max-w-[140px]">
                {destinationResourceId}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge variant={STATUS_BADGE_VARIANT[node.status]}>
            {STATUS_LABEL[node.status]}
          </Badge>
        </td>
        <td className="px-3 py-2 text-sm tabular-nums">{attemptCount}</td>
        {isOperatorPlus && (
          <td className="px-3 py-2 text-sm font-mono">
            {responseCode != null
              ? responseCode
              : errorCode
                ? errorCode
                : '—'}
          </td>
        )}
        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
          {ts}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-1">
            {node.can_replay && canRedispatch && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onRedispatch(node.id)}
                aria-label="Re-disparar job"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Re-dispatch
              </Button>
            )}
            {showWhy && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onWhyFailed(node.skip_reason ?? node.type)}
                aria-label="Por que?"
              >
                <HelpCircle className="h-3 w-3 mr-1" />
                Por que?
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Ocultar payload' : 'Ver payload'}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3 mr-1" />
              ) : (
                <ChevronRight className="h-3 w-3 mr-1" />
              )}
              Payload
            </Button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/30">
          <td colSpan={isOperatorPlus ? 7 : 6} className="px-3 py-2">
            <pre className="text-xs overflow-auto max-h-64 whitespace-pre-wrap break-all">
              {JSON.stringify(node.payload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function DispatchesTab({ leadPublicId, role }: DispatchesTabProps) {
  const [destFilter, setDestFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<NodeStatus | 'all'>('all');
  const [period, setPeriod] = useState<PeriodPreset>('all');

  const [whySheetOpen, setWhySheetOpen] = useState(false);
  const [whyReason, setWhyReason] = useState<string | null>(null);
  const [redispatchOpen, setRedispatchOpen] = useState(false);
  const [redispatchJobId, setRedispatchJobId] = useState<string | null>(null);

  const {
    error,
    isLoading,
    isValidating,
    size,
    setSize,
    mutate,
    allNodes,
    hasMore,
  } = useTimeline({
    leadPublicId,
    typeFilter: DISPATCH_NODE_TYPES,
    statusFilter,
    period,
  });

  // Discover destination universe from data for the multi-select.
  const destinationOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const n of allNodes) {
      const d = n.destination ?? getString(n.payload, 'destination');
      if (d) seen.add(d);
    }
    return Array.from(seen).sort();
  }, [allNodes]);

  const filteredNodes = useMemo(() => {
    if (destFilter.length === 0) return allNodes;
    return allNodes.filter((n) => {
      const d = n.destination ?? getString(n.payload, 'destination');
      return d ? destFilter.includes(d) : false;
    });
  }, [allNodes, destFilter]);

  const isOperatorPlus = role === 'operator' || role === 'admin';

  function toggleDest(d: string) {
    setDestFilter((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center p-4 rounded-lg border bg-muted/30">
        <div className="flex flex-wrap gap-1">
          {destinationOptions.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Sem destinos para filtrar
            </span>
          )}
          {destinationOptions.map((d) => {
            const active = destFilter.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDest(d)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={active}
              >
                {destinationLabel(d)}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 items-center ml-auto">
          <select
            className="text-xs rounded-md border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as NodeStatus | 'all')
            }
            aria-label="Filtrar por status"
          >
            <option value="all">Todos os status</option>
            <option value="ok">Sucesso</option>
            <option value="failed">Falha</option>
            <option value="skipped">Ignorado</option>
            <option value="pending">Pendente</option>
          </select>

          <select
            className="text-xs rounded-md border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodPreset)}
            aria-label="Filtrar por período"
          >
            {PERIOD_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => void mutate()}
            disabled={isValidating}
            aria-label="Atualizar despachos"
          >
            <RefreshCw
              className={cn('h-4 w-4', isValidating && 'animate-spin')}
            />
          </Button>
        </div>
      </div>

      {/* Table */}
      {isLoading && (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && error && (
        <div className="text-center py-12 space-y-3">
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar os despachos.
          </p>
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            Tentar novamente
          </Button>
        </div>
      )}

      {!isLoading && !error && filteredNodes.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">
            Sem despachos registrados.
          </p>
        </div>
      )}

      {!isLoading && !error && filteredNodes.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-muted/40">
              <tr className="border-b">
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Evento
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Destino
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Status
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tentativa
                </th>
                {isOperatorPlus && (
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Response
                  </th>
                )}
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Quando
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredNodes.map((node) => (
                <DispatchRow
                  key={node.id}
                  node={node}
                  role={role}
                  onWhyFailed={(r) => {
                    setWhyReason(r);
                    setWhySheetOpen(true);
                  }}
                  onRedispatch={(id) => {
                    setRedispatchJobId(id);
                    setRedispatchOpen(true);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <Button
          variant="outline"
          className="w-full mt-2"
          onClick={() => void setSize(size + 1)}
          disabled={isValidating}
        >
          {isValidating ? 'Carregando...' : 'Carregar mais antigos'}
        </Button>
      )}

      <WhyFailedSheet
        reason={whyReason}
        open={whySheetOpen}
        onClose={() => setWhySheetOpen(false)}
      />

      {redispatchJobId && (
        <RedispatchDialog
          open={redispatchOpen}
          onOpenChange={(open) => {
            setRedispatchOpen(open);
            if (!open) setRedispatchJobId(null);
          }}
          jobId={redispatchJobId}
        />
      )}
    </div>
  );
}
