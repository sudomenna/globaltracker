'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getSkipCopy } from '@/lib/skip-reason-copy';
import { X } from 'lucide-react';

interface WhyFailedSheetProps {
  reason: string | null;
  open: boolean;
  onClose: () => void;
}

// BR-DISPATCH-004: skip_reason copy servido offline via SKIP_REASON_COPY dict
export function WhyFailedSheet({ reason, open, onClose }: WhyFailedSheetProps) {
  if (!open) return null;

  const content = reason ? getSkipCopy(reason) : null;

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: aria-hidden overlay; keyboard close via Escape on dialog */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <dialog
        open
        aria-label="Por que isso aconteceu?"
        className="fixed right-0 top-0 z-50 h-full w-full max-w-md bg-background border-l shadow-xl flex flex-col p-0 border-0"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-base font-semibold">Por que isso aconteceu?</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Fechar painel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          {!reason && (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label="Carregando explicação"
            >
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          )}

          {reason && !content && (
            <p className="text-sm text-muted-foreground">
              Motivo não documentado
            </p>
          )}

          {content && (
            <div className="space-y-4">
              <h3 className="font-medium text-sm">{content.title}</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-line">
                {content.body}
              </p>
              {content.action && (
                <a
                  href={content.action.href}
                  className="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline border-t pt-3 w-full"
                >
                  {content.action.label}
                </a>
              )}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
