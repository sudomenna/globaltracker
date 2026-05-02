'use client';

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
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';

interface RedispatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
}

export function RedispatchDialog({
  open,
  onOpenChange,
  jobId,
}: RedispatchDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);

  const checkboxId = useId();
  const reasonId = useId();

  const canSubmit = confirmed && reason.trim().length >= 10 && !loading;

  function handleClose() {
    if (loading) return;
    setConfirmed(false);
    setReason('');
    setError(null);
    setAnnouncement('');
    onOpenChange(false);
  }

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const res = await edgeFetch(`/v1/dispatch-jobs/${jobId}/replay`, token, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `Erro ${res.status}`);
      }
      setAnnouncement('Re-dispatch enfileirado com sucesso');
      onOpenChange(false);
      setConfirmed(false);
      setReason('');
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Erro ao enfileirar re-dispatch';
      setError(msg);
      setAnnouncement(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* BR-DISPATCH: aria-live region announces result to assistive technology (WCAG 4.1.3) */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <AlertDialog open={open} onOpenChange={handleClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-disparar job</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação irá re-enfileirar o job para nova tentativa de despacho.
              Confirme apenas se tiver certeza.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id={checkboxId}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={loading}
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                aria-describedby={`${checkboxId}-desc`}
              />
              <label
                htmlFor={checkboxId}
                id={`${checkboxId}-desc`}
                className="text-sm leading-snug cursor-pointer select-none"
              >
                Confirmo que desejo re-disparar este job
              </label>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={reasonId} className="text-sm font-medium">
                Justificativa{' '}
                <span className="text-muted-foreground font-normal">
                  (mínimo 10 caracteres)
                </span>
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={loading}
                rows={3}
                placeholder="Descreva o motivo do re-dispatch..."
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 resize-none"
                aria-invalid={reason.length > 0 && reason.trim().length < 10}
                aria-describedby={
                  reason.length > 0 && reason.trim().length < 10
                    ? `${reasonId}-hint`
                    : undefined
                }
              />
              {reason.length > 0 && reason.trim().length < 10 && (
                <p
                  id={`${reasonId}-hint`}
                  className="text-xs text-destructive"
                  role="alert"
                >
                  Justificativa precisa ter ao menos 10 caracteres.
                </p>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirm()}
              disabled={!canSubmit}
            >
              {loading ? (
                <>
                  <RefreshCw
                    className="h-4 w-4 mr-2 animate-spin"
                    aria-hidden="true"
                  />
                  Enfileirando...
                </>
              ) : (
                'Confirmar re-dispatch'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
