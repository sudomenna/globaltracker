'use client';

// T-8-007: Live Event Console — Supabase Realtime stream com rolling window de 100 eventos
// T-8-008: Test Mode Toggle — POST /v1/workspace/test-mode
// T-8-010: Replay Modal — re-dispatch de evento em modo teste

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ReplayModal } from './ReplayModal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'paused'
  | 'reconnecting'
  | 'error';

type ProcessingStatus =
  | 'accepted'
  | 'enriched'
  | 'rejected_archived_launch'
  | 'rejected_consent'
  | 'rejected_validation';

interface EventRow {
  id: string;
  event_name: string;
  event_source: string;
  is_test: boolean;
  received_at: string;
  processing_status: ProcessingStatus;
  lead_id: string | null;
  page_id: string | null;
  event_id: string;
  launch_id: string | null;
  dispatch_job_id?: string | null;
}

interface TestModeStatus {
  active: boolean;
  ttlSeconds: number | null;
}

interface Props {
  workspaceId: string;
  launchId: string;
  accessToken: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTtl(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function processingStatusIcon(status: ProcessingStatus) {
  if (status === 'accepted' || status === 'enriched') {
    return (
      <CheckCircle
        className="h-4 w-4 text-green-600 shrink-0"
        aria-label="Aceito"
      />
    );
  }
  if (status === 'rejected_consent') {
    return (
      <AlertTriangle
        className="h-4 w-4 text-yellow-600 shrink-0"
        aria-label="Aviso de consentimento"
      />
    );
  }
  return (
    <XCircle className="h-4 w-4 text-red-600 shrink-0" aria-label="Rejeitado" />
  );
}

function processingStatusLabel(status: ProcessingStatus): string {
  const labels: Record<ProcessingStatus, string> = {
    accepted: 'Aceito',
    enriched: 'Enriquecido',
    rejected_archived_launch: 'Lançamento arquivado',
    rejected_consent: 'Sem consentimento',
    rejected_validation: 'Validação falhou',
  };
  return labels[status] ?? status;
}

function processingStatusVariant(
  status: ProcessingStatus,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (status === 'accepted' || status === 'enriched') return 'success';
  if (status === 'rejected_consent') return 'warning';
  if (status === 'rejected_archived_launch' || status === 'rejected_validation')
    return 'destructive';
  return 'secondary';
}

// ---------------------------------------------------------------------------
// Switch component (inline — no shadcn Switch installed)
// ---------------------------------------------------------------------------

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  'aria-describedby': describedBy,
}: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={[
        'relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Collapsible component (inline — no shadcn Collapsible installed)
// ---------------------------------------------------------------------------

interface CollapsibleProps {
  open: boolean;
  children: React.ReactNode;
}

function CollapsibleContent({ open, children }: CollapsibleProps) {
  if (!open) return null;
  return <div>{children}</div>;
}

// ---------------------------------------------------------------------------
// EventRow component
// ---------------------------------------------------------------------------

interface EventItemProps {
  event: EventRow;
  replayed: boolean;
  onReplayClick: (event: EventRow) => void;
}

function EventItem({ event, replayed, onReplayClick }: EventItemProps) {
  const [expanded, setExpanded] = useState(false);

  const canReplay = !event.is_test;

  return (
    <div
      className="border-b border-border px-4 py-3 hover:bg-muted/30 transition-colors"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded((v) => !v);
        }
      }}
    >
      <div className="flex items-start gap-3">
        {/* Status icon */}
        <div className="mt-0.5">
          {processingStatusIcon(event.processing_status)}
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatTime(event.received_at)}
            </span>
            <span className="font-medium text-sm">{event.event_name}</span>
            {event.is_test && (
              <Badge variant="warning" className="text-xs">
                TESTE
              </Badge>
            )}
            {replayed && (
              <Badge variant="secondary" className="text-xs">
                REPLAY
              </Badge>
            )}
            <Badge
              variant={processingStatusVariant(event.processing_status)}
              className="text-xs"
            >
              {processingStatusLabel(event.processing_status)}
            </Badge>
          </div>

          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>Fonte: {event.event_source}</span>
            {event.lead_id && (
              <a
                href={`/leads/${event.lead_id}`}
                className="text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Lead: {event.lead_id.slice(0, 8)}…
              </a>
            )}
          </div>
        </div>

        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          aria-label={expanded ? 'Recolher detalhes' : 'Expandir detalhes'}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Inline details */}
      <CollapsibleContent open={expanded}>
        <div className="mt-3 ml-7 p-3 bg-muted/50 rounded-md text-xs space-y-2 font-mono">
          <div>
            <span className="text-muted-foreground">event_id:</span>{' '}
            <span className="select-all">{event.event_id}</span>
          </div>
          <div>
            <span className="text-muted-foreground">id interno:</span>{' '}
            <span className="select-all">{event.id}</span>
          </div>
          <div>
            <span className="text-muted-foreground">recebido em:</span>{' '}
            {new Date(event.received_at).toISOString()}
          </div>
          {event.page_id && (
            <div>
              <span className="text-muted-foreground">page_id:</span>{' '}
              {event.page_id}
            </div>
          )}
          {event.lead_id && (
            <div className="pt-1">
              <a
                href={`/leads/${event.lead_id}`}
                className="text-primary hover:underline font-sans"
              >
                Ver lead na timeline →
              </a>
            </div>
          )}
          {/* Replay button — visible only for non-test events */}
          {canReplay && (
            <div className="pt-2 font-sans">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2 text-xs h-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onReplayClick(event);
                }}
                disabled={!event.dispatch_job_id}
                title={
                  !event.dispatch_job_id
                    ? 'Nenhum job de dispatch encontrado para este evento'
                    : undefined
                }
              >
                <RefreshCw className="h-3 w-3" />
                Replay como teste
              </Button>
              {!event.dispatch_job_id && (
                <p className="mt-1 text-muted-foreground text-xs">
                  Nenhum job de dispatch disponível para replay
                </p>
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

interface Filters {
  eventName: string;
  processingStatus: string;
}

interface FilterBarProps {
  events: EventRow[];
  filters: Filters;
  onChange: (filters: Filters) => void;
}

function FilterBar({ events, filters, onChange }: FilterBarProps) {
  // Collect unique event names seen so far
  const eventNames = Array.from(
    new Set(events.map((e) => e.event_name)),
  ).sort();
  const statuses: ProcessingStatus[] = [
    'accepted',
    'enriched',
    'rejected_consent',
    'rejected_archived_launch',
    'rejected_validation',
  ];

  return (
    <div className="flex items-center gap-3 flex-wrap text-sm">
      <label className="text-muted-foreground" htmlFor="filter-event-name">
        Evento:
      </label>
      <select
        id="filter-event-name"
        value={filters.eventName}
        onChange={(e) => onChange({ ...filters, eventName: e.target.value })}
        className="border border-input rounded-md px-2 py-1 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">todos</option>
        {eventNames.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <label className="text-muted-foreground" htmlFor="filter-status">
        Status:
      </label>
      <select
        id="filter-status"
        value={filters.processingStatus}
        onChange={(e) =>
          onChange({ ...filters, processingStatus: e.target.value })
        }
        className="border border-input rounded-md px-2 py-1 bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">todos</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {processingStatusLabel(s)}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection status indicator
// ---------------------------------------------------------------------------

function ConnectionIndicator({
  status,
  bufferCount,
}: { status: ConnectionStatus; bufferCount: number }) {
  if (status === 'connecting') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Conectando ao stream...</span>
      </div>
    );
  }
  if (status === 'connected') {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600">
        <Radio className="h-4 w-4" />
        <span>Conectado — recebendo eventos em tempo real</span>
      </div>
    );
  }
  if (status === 'paused') {
    return (
      <div className="flex items-center gap-2 text-sm text-yellow-600">
        <Pause className="h-4 w-4" />
        <span>
          Pausado
          {bufferCount > 0 && (
            <>
              {' '}
              — {bufferCount} evento{bufferCount !== 1 ? 's' : ''} no buffer —
              clique em retomar
            </>
          )}
        </span>
      </div>
    );
  }
  if (status === 'reconnecting') {
    return (
      <div className="flex items-center gap-2 text-sm text-yellow-600">
        <AlertTriangle className="h-4 w-4" />
        <span>Reconectando...</span>
      </div>
    );
  }
  // error
  return (
    <div className="flex items-center gap-2 text-sm text-destructive">
      <XCircle className="h-4 w-4" />
      <span>Conexão perdida — recarregue a página</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main EventConsole
// ---------------------------------------------------------------------------

export function EventConsole({ workspaceId, launchId, accessToken }: Props) {
  // State
  const [events, setEvents] = useState<EventRow[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [buffer, setBuffer] = useState<EventRow[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting');
  const [testModeStatus, setTestModeStatus] = useState<TestModeStatus>({
    active: false,
    ttlSeconds: null,
  });
  const [filters, setFilters] = useState<Filters>({
    eventName: '',
    processingStatus: '',
  });
  const [showTestModeConfirm, setShowTestModeConfirm] = useState(false);
  const [pendingTestMode, setPendingTestMode] = useState<boolean>(false);
  const [replayModal, setReplayModal] = useState<{
    open: boolean;
    event: EventRow | null;
    jobId: string | null;
  }>({ open: false, event: null, jobId: null });
  const [replayedEventIds, setReplayedEventIds] = useState<Set<string>>(
    new Set(),
  );

  // Refs
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  const parentRef = useRef<HTMLDivElement>(null);

  // Edge API base URL — BR: never hardcode prod URLs
  const edgeApiBase = process.env.NEXT_PUBLIC_EDGE_API_URL ?? '/api';

  // ---------------------------------------------------------------------------
  // Test mode TTL countdown
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!testModeStatus.active || testModeStatus.ttlSeconds === null) return;

    const interval = setInterval(() => {
      setTestModeStatus((prev) => {
        if (prev.ttlSeconds === null || prev.ttlSeconds <= 0) {
          clearInterval(interval);
          return { active: false, ttlSeconds: null };
        }
        return { ...prev, ttlSeconds: prev.ttlSeconds - 1 };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [testModeStatus.active, testModeStatus.ttlSeconds]);

  // ---------------------------------------------------------------------------
  // Fetch initial test mode state
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function fetchTestMode() {
      try {
        const res = await fetch(`${edgeApiBase}/v1/workspace/test-mode`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            enabled: boolean;
            ttl_seconds: number | null;
          };
          setTestModeStatus({
            active: data.enabled,
            ttlSeconds: data.ttl_seconds,
          });
        }
      } catch {
        // silently ignore — not critical
      }
    }
    fetchTestMode();
  }, [edgeApiBase, accessToken]);

  // ---------------------------------------------------------------------------
  // Supabase Realtime subscription
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const supabase = createSupabaseBrowser();

    const channel = supabase
      .channel(`workspace-events-${workspaceId}`)
      .on(
        // biome-ignore lint/suspicious/noExplicitAny: Supabase realtime payload type
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'events',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        // biome-ignore lint/suspicious/noExplicitAny: Supabase realtime payload
        (payload: any) => {
          const row = payload.new as EventRow;

          if (isPausedRef.current) {
            setBuffer((prev) => [row, ...prev]);
            return;
          }

          setEvents((prev) => {
            const next = [row, ...prev];
            return next.slice(0, MAX_EVENTS);
          });
        },
      )
      // biome-ignore lint/suspicious/noExplicitAny: Supabase realtime system event
      .on('system' as any, {}, (status: string) => {
        if (status === 'SUBSCRIBED') {
          setConnectionStatus('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnectionStatus('reconnecting');
        } else if (status === 'CLOSED') {
          setConnectionStatus('error');
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConnectionStatus('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnectionStatus('reconnecting');
        } else if (status === 'CLOSED') {
          setConnectionStatus('error');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  // ---------------------------------------------------------------------------
  // Pause / Resume
  // ---------------------------------------------------------------------------

  const handlePauseResume = useCallback(() => {
    if (isPaused) {
      // Resume: merge buffer into events
      setEvents((prev) => {
        const merged = [...bufferRef.current, ...prev];
        return merged.slice(0, MAX_EVENTS);
      });
      setBuffer([]);
      setIsPaused(false);
      setConnectionStatus('connected');
    } else {
      setIsPaused(true);
      setConnectionStatus('paused');
    }
  }, [isPaused]);

  // Keyboard shortcut: Space or P to pause/resume
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === ' ' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        handlePauseResume();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handlePauseResume]);

  // ---------------------------------------------------------------------------
  // Clear events
  // ---------------------------------------------------------------------------

  const handleClear = useCallback(() => {
    setEvents([]);
    setBuffer([]);
  }, []);

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  const handleReplayClick = useCallback((event: EventRow) => {
    setReplayModal({
      open: true,
      event,
      jobId: event.dispatch_job_id ?? null,
    });
  }, []);

  const handleReplaySuccess = useCallback((newJobId: string) => {
    setReplayModal((prev) => {
      if (prev.event) {
        setReplayedEventIds((ids) => {
          const next = new Set(ids);
          next.add(prev.event!.id);
          return next;
        });
      }
      // newJobId will appear organically in the stream via Realtime
      void newJobId;
      return { open: false, event: null, jobId: null };
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Test mode toggle
  // ---------------------------------------------------------------------------

  const handleTestModeToggleRequest = useCallback((enabled: boolean) => {
    if (enabled) {
      // Show confirmation before activating
      setPendingTestMode(true);
      setShowTestModeConfirm(true);
    } else {
      // Deactivate immediately
      void applyTestMode(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function applyTestMode(enabled: boolean) {
    try {
      const res = await fetch(`${edgeApiBase}/v1/workspace/test-mode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ enabled }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          enabled: boolean;
          ttl_seconds: number | null;
        };
        setTestModeStatus({
          active: data.enabled,
          ttlSeconds: data.ttl_seconds,
        });
        toast.success(
          data.enabled
            ? 'Modo teste ativado (TTL: 1h)'
            : 'Modo teste desativado',
        );
      } else {
        toast.error('Falha ao alterar modo teste');
      }
    } catch {
      toast.error('Erro de rede ao alterar modo teste');
    }
  }

  function handleConfirmTestMode() {
    setShowTestModeConfirm(false);
    void applyTestMode(pendingTestMode);
  }

  // ---------------------------------------------------------------------------
  // Filtered events
  // ---------------------------------------------------------------------------

  const filteredEvents = events.filter((e) => {
    if (testModeStatus.active && !e.is_test) return false;
    if (filters.eventName && e.event_name !== filters.eventName) return false;
    if (
      filters.processingStatus &&
      e.processing_status !== filters.processingStatus
    )
      return false;
    return true;
  });

  // ---------------------------------------------------------------------------
  // Virtualizer
  // ---------------------------------------------------------------------------

  const rowVirtualizer = useVirtualizer({
    count: filteredEvents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 5,
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* ── Test mode warning banner ── */}
      {testModeStatus.active && (
        <div
          id="test-mode-banner"
          className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm space-y-2"
          role="alert"
        >
          <div className="flex items-center gap-2 font-semibold text-yellow-800">
            <AlertTriangle className="h-4 w-4" />
            Modo teste ATIVO
          </div>
          <ul className="list-disc list-inside text-yellow-700 space-y-1">
            <li>Meta CAPI usa META_CAPI_TEST_EVENT_CODE</li>
            <li>GA4 MP usa debug_mode=1</li>
            <li>Eventos NÃO contam para audiences nem dashboards</li>
          </ul>
          {testModeStatus.ttlSeconds !== null && (
            <div className="flex items-center gap-3 text-yellow-800">
              <span>
                Auto-desliga em:{' '}
                <strong className="tabular-nums">
                  {formatTtl(testModeStatus.ttlSeconds)}
                </strong>
              </span>
              <Button
                size="sm"
                variant="outline"
                className="border-yellow-400 text-yellow-800 hover:bg-yellow-100"
                onClick={() => handleTestModeToggleRequest(false)}
              >
                Desligar agora
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Reconnecting banner ── */}
      {connectionStatus === 'reconnecting' && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Reconectando ao stream... eventos recebidos estão preservados.
        </div>
      )}

      {/* ── Controls bar ── */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        {/* Row 1: action buttons + test mode */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Pause / Resume */}
          <Button
            variant="outline"
            size="sm"
            onClick={handlePauseResume}
            className="gap-2"
            disabled={
              connectionStatus === 'error' || connectionStatus === 'connecting'
            }
          >
            {isPaused ? (
              <>
                <Play className="h-4 w-4" />
                Retomar
              </>
            ) : (
              <>
                <Pause className="h-4 w-4" />
                Pausar
              </>
            )}
          </Button>

          {/* Test mode toggle */}
          <div className="flex items-center gap-2">
            <label
              htmlFor="test-mode-switch"
              className="text-sm text-muted-foreground"
            >
              Modo teste:
            </label>
            <Switch
              id="test-mode-switch"
              checked={testModeStatus.active}
              onCheckedChange={handleTestModeToggleRequest}
              aria-describedby={
                testModeStatus.active ? 'test-mode-banner' : undefined
              }
            />
            <span className="text-sm font-medium">
              {testModeStatus.active ? 'ON' : 'OFF'}
            </span>
          </div>

          {/* Clear */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="gap-2 text-muted-foreground"
          >
            <Trash2 className="h-4 w-4" />
            Limpar
          </Button>
        </div>

        {/* Row 2: Filters */}
        <FilterBar events={events} filters={filters} onChange={setFilters} />
      </div>

      {/* ── Connection status indicator ── */}
      <ConnectionIndicator
        status={connectionStatus}
        bufferCount={buffer.length}
      />

      {/* ── Event stream ── */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {connectionStatus === 'connecting' && (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Conectando ao stream...</span>
          </div>
        )}

        {connectionStatus === 'error' && (
          <div className="flex items-center justify-center gap-2 py-12 text-destructive">
            <XCircle className="h-5 w-5" />
            <span>Conexão perdida — recarregue a página</span>
          </div>
        )}

        {(connectionStatus === 'connected' ||
          connectionStatus === 'paused' ||
          connectionStatus === 'reconnecting') &&
          (filteredEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
              <Radio className="h-8 w-8 opacity-30" />
              {isPaused ? (
                <p className="text-sm">Stream pausado.</p>
              ) : (
                <>
                  <p className="text-sm font-medium">Aguardando eventos.</p>
                  <p className="text-xs">
                    Submeta um form em sua LP para ver eventos aparecerem aqui.
                  </p>
                </>
              )}
            </div>
          ) : (
            /* Virtualized list */
            <div
              ref={parentRef}
              className="max-h-[600px] overflow-y-auto"
              aria-live="polite"
              aria-label="Stream de eventos ao vivo"
            >
              <div
                style={{
                  height: `${rowVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const event = filteredEvents[virtualRow.index];
                  if (!event) return null;
                  return (
                    <div
                      key={virtualRow.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                    >
                      <EventItem
                          event={event}
                          replayed={replayedEventIds.has(event.id)}
                          onReplayClick={handleReplayClick}
                        />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>

      {/* ── Event count ── */}
      {filteredEvents.length > 0 && (
        <p className="text-xs text-muted-foreground text-right">
          Exibindo {filteredEvents.length} evento
          {filteredEvents.length !== 1 ? 's' : ''} (máx. {MAX_EVENTS} em rolling
          window)
        </p>
      )}

      {/* ── Replay modal ── */}
      <ReplayModal
        open={replayModal.open}
        onOpenChange={(open) =>
          setReplayModal((prev) => ({ ...prev, open }))
        }
        event={replayModal.event}
        dispatchJobId={replayModal.jobId}
        onReplaySuccess={handleReplaySuccess}
        accessToken={accessToken}
      />

      {/* ── Test mode confirmation dialog ── */}
      <AlertDialog
        open={showTestModeConfirm}
        onOpenChange={setShowTestModeConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ativar modo teste?</AlertDialogTitle>
            <AlertDialogDescription>
              Com o modo teste ativo, os eventos serão marcados como{' '}
              <code>is_test=true</code> e os dispatchers usarão credenciais de
              teste (Meta CAPI test_event_code, GA4 debug_mode). Os eventos{' '}
              <strong>não</strong> contarão para dashboards nem audiences.
              <br />
              <br />O modo teste se auto-desliga em <strong>1 hora</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmTestMode}>
              Ativar modo teste
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
