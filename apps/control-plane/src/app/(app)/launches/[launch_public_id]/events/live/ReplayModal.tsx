'use client';

// T-8-010: Replay Modal — re-dispatch de evento em modo teste
// CONTRACT-api-dispatch-replay-v1

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventRow {
  id: string;
  event_name: string;
  event_source: string;
  is_test: boolean;
  received_at: string;
  processing_status: string;
  lead_id: string | null;
  page_id: string | null;
  event_id: string;
  launch_id: string | null;
  dispatch_job_id?: string | null;
}

interface ReplayModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: EventRow | null;
  dispatchJobId: string | null;
  onReplaySuccess: (newJobId: string) => void;
  accessToken: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `há ${diffSecs}s`;
  if (diffMins < 60) return `há ${diffMins}min`;
  if (diffHours < 24) return `há ${diffHours}h`;
  return `há ${diffDays}d`;
}

// ---------------------------------------------------------------------------
// ReplayModal
// ---------------------------------------------------------------------------

export function ReplayModal({
  open,
  onOpenChange,
  event,
  dispatchJobId,
  onReplaySuccess,
  accessToken,
}: ReplayModalProps) {
  const [justification, setJustification] = useState('');
  const [justificationError, setJustificationError] = useState<string | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setJustification('');
      setJustificationError(null);
      setIsLoading(false);
      // Focus textarea after transition
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
    }
  }, [open]);

  const edgeApiBase = process.env.NEXT_PUBLIC_EDGE_API_URL ?? '/api';

  const handleConfirm = useCallback(async () => {
    // BR: justificativa obrigatória
    if (!justification.trim()) {
      setJustificationError('Justificativa é obrigatória');
      textareaRef.current?.focus();
      return;
    }

    if (!dispatchJobId) {
      toast.error('Nenhum job de dispatch encontrado para este evento');
      return;
    }

    setIsLoading(true);
    setJustificationError(null);

    try {
      const res = await fetch(
        `${edgeApiBase}/v1/dispatch-jobs/${dispatchJobId}/replay`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            test_mode: true,
            justification: justification.trim(),
          }),
        },
      );

      if (res.status === 202) {
        const data = (await res.json()) as {
          new_job_id: string;
          status: string;
        };
        onOpenChange(false);
        onReplaySuccess(data.new_job_id);
        toast.success('Replay enfileirado');
        return;
      }

      if (res.status === 409) {
        toast.error('Este job já está em processamento');
        return;
      }

      // Generic error
      toast.error('Erro ao enfileirar replay — tente novamente');
    } catch {
      toast.error('Erro ao enfileirar replay — tente novamente');
    } finally {
      setIsLoading(false);
    }
  }, [
    justification,
    dispatchJobId,
    edgeApiBase,
    accessToken,
    onOpenChange,
    onReplaySuccess,
  ]);

  const hasDispatchJob = Boolean(dispatchJobId);

  if (!event) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Replay evento</AlertDialogTitle>
        </AlertDialogHeader>

        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Re-enviar este evento em modo teste?
          </p>

          {/* Evento original */}
          <div className="rounded-md border border-border bg-muted/40 p-3 space-y-1 text-xs font-mono">
            <div className="font-sans font-medium text-sm text-foreground mb-2">
              Evento original:
            </div>
            <div>
              <span className="text-muted-foreground">evento:</span>{' '}
              <span>{event.event_name}</span>{' '}
              <span className="text-muted-foreground">
                ({formatRelativeTime(event.received_at)})
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">lead:</span>{' '}
              <span>{event.lead_id ?? 'anônimo'}</span>
            </div>
            {event.page_id && (
              <div>
                <span className="text-muted-foreground">page_id:</span>{' '}
                <span>{event.page_id}</span>
              </div>
            )}
          </div>

          {/* Aviso quando não há dispatch job */}
          {!hasDispatchJob && (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800">
              Nenhum job de dispatch encontrado para este evento. O replay não
              está disponível.
            </div>
          )}

          {/* Justificativa */}
          <div className="space-y-1">
            <label
              htmlFor="replay-justification"
              className="font-medium text-sm text-foreground"
            >
              Justificativa{' '}
              <span className="text-muted-foreground font-normal">
                (obrigatório)
              </span>
            </label>
            <textarea
              id="replay-justification"
              ref={textareaRef}
              value={justification}
              onChange={(e) => {
                setJustification(e.target.value);
                if (justificationError && e.target.value.trim()) {
                  setJustificationError(null);
                }
              }}
              disabled={isLoading || !hasDispatchJob}
              placeholder="Ex: validando comportamento do dispatcher Meta após correção de bug"
              rows={3}
              className={[
                'w-full resize-none rounded-md border bg-background px-3 py-2 text-sm',
                'placeholder:text-muted-foreground',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                'disabled:pointer-events-none disabled:opacity-50',
                justificationError ? 'border-destructive' : 'border-input',
              ].join(' ')}
              aria-describedby={
                justificationError ? 'replay-justification-error' : undefined
              }
              aria-invalid={Boolean(justificationError)}
            />
            {justificationError && (
              <p
                id="replay-justification-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {justificationError}
              </p>
            )}
          </div>
        </div>

        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isLoading || !hasDispatchJob}
            className="gap-2"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar replay
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
