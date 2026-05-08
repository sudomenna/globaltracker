'use client';

/**
 * reveal-pii-button.tsx — ADR-034 reveal-on-demand UI for operator role.
 *
 * Shown when the server-rendered summary indicates `pii_masked: true` and the
 * user's role is allowed to reveal (not 'viewer'). Click → modal pede reason →
 * POST /v1/leads/:id/reveal-pii → mostra valores em claro inline.
 */

import { useState } from 'react';
import { Eye, Loader2, X } from 'lucide-react';

interface Props {
  leadPublicId: string;
  accessToken: string;
  edgeUrl: string;
}

export function RevealPiiButton({ leadPublicId, accessToken, edgeUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{
    email: string | null;
    phone: string | null;
  } | null>(null);

  async function submit() {
    if (reason.trim().length < 3) {
      setError('Razão precisa ter ao menos 3 caracteres.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${edgeUrl}/v1/leads/${encodeURIComponent(leadPublicId)}/reveal-pii`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason }),
        },
      );
      if (!res.ok) {
        setError(`Erro ${res.status} — sem permissão ou indisponível.`);
        return;
      }
      const body = (await res.json()) as {
        display_email: string | null;
        display_phone: string | null;
      };
      setRevealed({ email: body.display_email, phone: body.display_phone });
      setOpen(false);
    } catch {
      setError('Falha de rede.');
    } finally {
      setLoading(false);
    }
  }

  if (revealed) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
        <p className="text-xs text-amber-700 mb-1 font-medium">
          PII revelada (acesso registrado em audit log)
        </p>
        <p className="text-sm">
          <span className="font-mono">{revealed.email ?? '—'}</span>
          {' · '}
          <span className="font-mono">{revealed.phone ?? '—'}</span>
        </p>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        Revelar PII
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          onClick={() => !loading && setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !loading) setOpen(false);
          }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="rounded-lg border bg-background p-6 shadow-lg max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-lg font-semibold">Revelar PII</h2>
              <button
                type="button"
                onClick={() => !loading && setOpen(false)}
                disabled={loading}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Fechar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Esta ação será registrada no audit log com sua identidade,
              o lead acessado e a razão informada.
            </p>
            <label className="block text-xs font-medium mb-1.5">
              Razão (mín. 3 caracteres)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
              placeholder="Ex.: Suporte ao cliente — ticket #12345"
              disabled={loading}
            />
            {error && (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={loading}
                className="px-3 py-1.5 text-sm rounded-md border hover:bg-accent disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={loading || reason.trim().length < 3}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Confirmar e revelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
