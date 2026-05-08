'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { cn } from '@/lib/utils';
import {
  Activity,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitMerge,
  HelpCircle,
  Layers,
  MinusCircle,
  RefreshCw,
  Send,
  Shield,
  XCircle,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { RedispatchDialog } from './redispatch-dialog';
import { WhyFailedSheet } from './why-failed-sheet';

// BR-IDENTITY-013: browser nunca usa lead_id interno; usa lead_public_id

export type NodeType =
  | 'event_captured'
  | 'dispatch_queued'
  | 'dispatch_success'
  | 'dispatch_failed'
  | 'dispatch_skipped'
  | 'attribution_set'
  | 'stage_changed'
  | 'merge'
  | 'consent_updated';

export type NodeStatus = 'ok' | 'failed' | 'skipped' | 'pending';

interface TimelineNode {
  id: string;
  type: NodeType;
  occurred_at: string;
  status: NodeStatus;
  payload: Record<string, unknown>;
  skip_reason: string | null;
  can_replay: boolean;
}

interface TimelineResponse {
  nodes: TimelineNode[];
  next_cursor: string | null;
}

const NODE_CONFIG: Record<
  NodeType,
  {
    Icon: React.ComponentType<{ className?: string }>;
    label: string;
    iconColorClass: string;
  }
> = {
  event_captured: {
    Icon: Activity,
    label: 'Evento capturado',
    iconColorClass: 'text-green-600',
  },
  dispatch_queued: {
    Icon: Send,
    label: 'Despacho enfileirado',
    iconColorClass: 'text-blue-600',
  },
  dispatch_success: {
    Icon: CheckCircle,
    label: 'Despachado com sucesso',
    iconColorClass: 'text-green-600',
  },
  dispatch_failed: {
    Icon: XCircle,
    label: 'Despacho com falha',
    iconColorClass: 'text-red-600',
  },
  dispatch_skipped: {
    Icon: MinusCircle,
    label: 'Despacho ignorado',
    iconColorClass: 'text-yellow-600',
  },
  attribution_set: {
    Icon: GitBranch,
    label: 'Atribuição definida',
    iconColorClass: 'text-purple-600',
  },
  stage_changed: {
    Icon: Layers,
    label: 'Stage alterado',
    iconColorClass: 'text-gray-600',
  },
  merge: {
    Icon: GitMerge,
    label: 'Lead unificado',
    iconColorClass: 'text-orange-600',
  },
  consent_updated: {
    Icon: Shield,
    label: 'Consentimento atualizado',
    iconColorClass: 'text-blue-600',
  },
};

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

// BR-PRIVACY: mask PII for marketer role
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '****';
  return `${local[0] ?? '*'}***@${domain.slice(0, 2)}**.com`;
}

function maskPhone(phone: string): string {
  return `****${phone.slice(-4)}`;
}

// BR-PRIVACY: sanitize payload display for marketer
function sanitizePayloadForMarketer(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      typeof value === 'string' &&
      (key.toLowerCase().includes('email') ||
        key.toLowerCase().includes('phone') ||
        key.toLowerCase() === 'em' ||
        key.toLowerCase() === 'ph')
    ) {
      if (key.toLowerCase().includes('email') || key === 'em') {
        sanitized[key] = value.includes('@') ? maskEmail(value) : '****';
      } else {
        sanitized[key] = maskPhone(value);
      }
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      sanitized[key] = sanitizePayloadForMarketer(
        value as Record<string, unknown>,
      );
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

const NODE_TYPES: NodeType[] = [
  'event_captured',
  'dispatch_queued',
  'dispatch_success',
  'dispatch_failed',
  'dispatch_skipped',
  'attribution_set',
  'stage_changed',
  'merge',
  'consent_updated',
];

const PERIOD_PRESETS = [
  { label: 'Tudo', value: 'all' },
  { label: 'Últimas 24h', value: '24h' },
  { label: '7 dias', value: '7d' },
  { label: '30 dias', value: '30d' },
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number]['value'];

interface TimelineNodeCardProps {
  node: TimelineNode;
  role: string;
  onWhyFailed: (reason: string) => void;
  onRedispatch: (jobId: string) => void;
}

function TimelineNodeCard({
  node,
  role,
  onWhyFailed,
  onRedispatch,
}: TimelineNodeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = NODE_CONFIG[node.type];
  const { Icon, label, iconColorClass } = config;
  const isMarketer = role === 'marketer';
  // BR-RBAC: only operator/admin may trigger re-dispatch
  const canRedispatch = role === 'operator' || role === 'admin';

  const displayPayload = isMarketer
    ? sanitizePayloadForMarketer(node.payload)
    : node.payload;

  const showWhyButton = node.status === 'failed' || node.status === 'skipped';

  const timestamp = new Date(node.occurred_at).toLocaleString('pt-BR');

  return (
    <div className="flex gap-4">
      {/* Timeline connector */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 bg-background',
            node.status === 'ok' && 'border-green-500',
            node.status === 'failed' && 'border-red-500',
            node.status === 'skipped' && 'border-yellow-500',
            node.status === 'pending' && 'border-gray-300',
          )}
          aria-hidden="true"
        >
          <Icon className={cn('h-4 w-4', iconColorClass)} />
        </div>
        <div className="w-px flex-1 bg-border mt-1" aria-hidden="true" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-6 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span
            className="text-sm font-medium"
            aria-label={`${label}: ${STATUS_LABEL[node.status]}`}
          >
            {label}
          </span>
          <Badge variant={STATUS_BADGE_VARIANT[node.status]}>
            {STATUS_LABEL[node.status]}
          </Badge>
          {showWhyButton && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onWhyFailed(node.skip_reason ?? node.type)}
              aria-label={`Por que "${label}" aconteceu?`}
            >
              <HelpCircle className="h-3 w-3 mr-1" />
              Por que isso aconteceu?
            </Button>
          )}
          {/* BR-DISPATCH: re-dispatch only available for replayable jobs; restricted to operator/admin */}
          {node.can_replay && (
            <Tooltip
              content={
                canRedispatch
                  ? 'Re-disparar este job'
                  : 'Apenas Operator/Admin pode re-disparar'
              }
            >
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={
                  canRedispatch ? () => onRedispatch(node.id) : undefined
                }
                disabled={!canRedispatch}
                aria-label={
                  canRedispatch
                    ? 'Re-disparar job'
                    : 'Apenas Operator/Admin pode re-disparar'
                }
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Re-dispatch
              </Button>
            </Tooltip>
          )}
        </div>

        <p className="text-xs text-muted-foreground mb-2">{timestamp}</p>

        {/* Collapsible payload */}
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={`payload-${node.id}`}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {expanded ? 'Ocultar payload' : 'Ver payload'}
        </button>

        {expanded && (
          <pre
            id={`payload-${node.id}`}
            className="mt-2 rounded-md bg-muted p-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-all"
          >
            {JSON.stringify(displayPayload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function buildTimelineUrl(
  leadPublicId: string,
  cursor: string | null,
  typeFilter: NodeType[],
  statusFilter: NodeStatus | 'all',
  period: PeriodPreset,
): string {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (cursor) params.set('cursor', cursor);
  if (typeFilter.length > 0 && typeFilter.length < NODE_TYPES.length) {
    params.set('filters', typeFilter.join(','));
  }
  if (statusFilter !== 'all') params.set('status', statusFilter);
  if (period !== 'all') {
    const now = new Date();
    if (period === '24h') {
      params.set('since', new Date(now.getTime() - 86400000).toISOString());
    } else if (period === '7d') {
      params.set('since', new Date(now.getTime() - 7 * 86400000).toISOString());
    } else if (period === '30d') {
      params.set(
        'since',
        new Date(now.getTime() - 30 * 86400000).toISOString(),
      );
    }
  }
  return `/v1/leads/${encodeURIComponent(leadPublicId)}/timeline?${params.toString()}`;
}

interface LeadTimelineClientProps {
  leadPublicId: string;
  role: string;
  initialTypeFilter: NodeType[];
  initialStatusFilter: NodeStatus | 'all';
  initialPeriod: PeriodPreset;
}

export function LeadTimelineClient({
  leadPublicId,
  role,
  initialTypeFilter,
  initialStatusFilter,
  initialPeriod,
}: LeadTimelineClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [typeFilter, setTypeFilter] = useState<NodeType[]>(initialTypeFilter);
  const [statusFilter, setStatusFilter] = useState<NodeStatus | 'all'>(
    initialStatusFilter,
  );
  const [period, setPeriod] = useState<PeriodPreset>(initialPeriod);

  const [whySheetOpen, setWhySheetOpen] = useState(false);
  const [whyReason, setWhyReason] = useState<string | null>(null);
  const [redispatchOpen, setRedispatchOpen] = useState(false);
  const [redispatchJobId, setRedispatchJobId] = useState<string | null>(null);

  const syncQueryParams = useCallback(
    (
      newType: NodeType[],
      newStatus: NodeStatus | 'all',
      newPeriod: PeriodPreset,
    ) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'timeline');
      if (newType.length > 0 && newType.length < NODE_TYPES.length) {
        params.set('types', newType.join(','));
      } else {
        params.delete('types');
      }
      if (newStatus !== 'all') {
        params.set('status', newStatus);
      } else {
        params.delete('status');
      }
      if (newPeriod !== 'all') {
        params.set('period', newPeriod);
      } else {
        params.delete('period');
      }
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const getKey = useCallback(
    (pageIndex: number, previousData: TimelineResponse | null) => {
      if (previousData && !previousData.next_cursor) return null;
      const cursor =
        pageIndex === 0 ? null : (previousData?.next_cursor ?? null);
      return buildTimelineUrl(
        leadPublicId,
        cursor,
        typeFilter,
        statusFilter,
        period,
      );
    },
    [leadPublicId, typeFilter, statusFilter, period],
  );

  const fetcher = useCallback(
    async (url: string): Promise<TimelineResponse> => {
      const supabase = createSupabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const res = await edgeFetch(url, token);
      if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
      return res.json() as Promise<TimelineResponse>;
    },
    [],
  );

  const { data, error, isLoading, isValidating, size, setSize, mutate } =
    useSWRInfinite<TimelineResponse>(getKey, fetcher);

  const allNodes = data?.flatMap((page) => page.nodes) ?? [];
  const lastPage = data?.[data.length - 1];
  const hasMore = !!lastPage?.next_cursor;

  function handleTypeToggle(type: NodeType) {
    const next = typeFilter.includes(type)
      ? typeFilter.filter((t) => t !== type)
      : [...typeFilter, type];
    setTypeFilter(next);
    syncQueryParams(next, statusFilter, period);
  }

  function handleStatusChange(s: NodeStatus | 'all') {
    setStatusFilter(s);
    syncQueryParams(typeFilter, s, period);
  }

  function handlePeriodChange(p: PeriodPreset) {
    setPeriod(p);
    syncQueryParams(typeFilter, statusFilter, p);
  }

  function handleWhyFailed(reason: string) {
    setWhyReason(reason);
    setWhySheetOpen(true);
  }

  function handleRedispatch(jobId: string) {
    setRedispatchJobId(jobId);
    setRedispatchOpen(true);
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center p-4 rounded-lg border bg-muted/30">
        {/* Type filter */}
        <div className="flex flex-wrap gap-1">
          {NODE_TYPES.map((type) => {
            const { Icon, label } = NODE_CONFIG[type];
            const active = typeFilter.includes(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => handleTypeToggle(type)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={active}
                aria-label={`Filtrar por ${label}`}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 items-center">
          {/* Status filter */}
          <select
            className="text-xs rounded-md border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            value={statusFilter}
            onChange={(e) =>
              handleStatusChange(e.target.value as NodeStatus | 'all')
            }
            aria-label="Filtrar por status"
          >
            <option value="all">Todos os status</option>
            <option value="ok">Sucesso</option>
            <option value="failed">Falha</option>
            <option value="skipped">Ignorado</option>
            <option value="pending">Pendente</option>
          </select>

          {/* Period filter */}
          <select
            className="text-xs rounded-md border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            value={period}
            onChange={(e) => handlePeriodChange(e.target.value as PeriodPreset)}
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
            aria-label="Atualizar timeline"
          >
            <RefreshCw
              className={cn('h-4 w-4', isValidating && 'animate-spin')}
            />
          </Button>
        </div>
      </div>

      {/* Timeline */}
      <div>
        {isLoading && (
          <div
            className="space-y-4"
            aria-busy="true"
            aria-label="Carregando timeline"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders have no meaningful id
              <div key={i} className="flex gap-4">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="flex-1 space-y-2 pt-1">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!isLoading && error && (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">
              Não foi possível carregar a timeline.
            </p>
            <Button variant="outline" size="sm" onClick={() => void mutate()}>
              Tentar novamente
            </Button>
          </div>
        )}

        {!isLoading && !error && allNodes.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm text-muted-foreground">
              Esse lead ainda não tem atividade registrada.
            </p>
          </div>
        )}

        {!isLoading && !error && allNodes.length > 0 && (
          <div>
            {allNodes.map((node) => (
              <TimelineNodeCard
                key={node.id}
                node={node}
                role={role}
                onWhyFailed={handleWhyFailed}
                onRedispatch={handleRedispatch}
              />
            ))}

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
          </div>
        )}
      </div>

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
