'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface SkipReasonContent {
  title: string;
  body: string;
  action?: string;
}

interface WhyFailedSheetProps {
  reason: string | null;
  open: boolean;
  onClose: () => void;
}

export function WhyFailedSheet({ reason, open, onClose }: WhyFailedSheetProps) {
  const [content, setContent] = useState<SkipReasonContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!open || !reason) return;

    setContent(null);
    setNotFound(false);
    setLoading(true);

    async function load() {
      if (!reason) return;
      try {
        const supabase = createSupabaseBrowser();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token ?? '';
        const res = await edgeFetch(
          `/v1/help/skip-reason/${encodeURIComponent(reason)}`,
          token,
        );
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const data = (await res.json()) as SkipReasonContent;
        setContent(data);
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [open, reason]);

  if (!open) return null;

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
          {loading && (
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

          {!loading && notFound && (
            <p className="text-sm text-muted-foreground">
              Motivo não documentado
            </p>
          )}

          {!loading && content && (
            <div className="space-y-4">
              <h3 className="font-medium text-sm">{content.title}</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-line">
                {content.body}
              </p>
              {content.action && (
                <p className="text-sm font-medium border-t pt-3">
                  {content.action}
                </p>
              )}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
