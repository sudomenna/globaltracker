'use client';

import { Button } from '@/components/ui/button';
import { CheckCircle2, Clock, Copy, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import useSWR from 'swr';
import type { OnboardingState, PageStatus } from './types';

const POLL_INTERVAL_PENDING_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

interface StepInstallProps {
  state: OnboardingState['step_install'];
  pagePublicId?: string;
  pageToken?: string;
  launchPublicId?: string;
  accessToken: string;
  onComplete: (data: OnboardingState['step_install']) => void;
  onSkip: () => void;
}

function buildSnippet(
  pageToken: string,
  launchPublicId: string,
  pagePublicId: string,
): string {
  return `<script
  src="https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js"
  data-site-token="${pageToken}"
  data-launch-public-id="${launchPublicId}"
  data-page-public-id="${pagePublicId}">
</script>`;
}

export function StepInstall({
  state,
  pagePublicId,
  pageToken,
  launchPublicId,
  accessToken,
  onComplete,
  onSkip,
}: StepInstallProps) {
  const [timedOut, setTimedOut] = useState(false);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef(Date.now());

  const isTerminal = (status?: PageStatus) =>
    status?.health_state === 'healthy' || status?.health_state === 'unhealthy';

  const { data: pageStatus } = useSWR<PageStatus>(
    pagePublicId && !timedOut ? `/v1/pages/${pagePublicId}/status` : null,
    async (path: string) => {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787'}${path}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error('status fetch failed');
      return res.json() as Promise<PageStatus>;
    },
    {
      // Polling agressivo enquanto pendente — docs/70-ux/09-interaction-patterns.md §Polling
      refreshInterval: (data) =>
        isTerminal(data) ? 60_000 : POLL_INTERVAL_PENDING_MS,
      revalidateOnFocus: false,
    },
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect — starts the 5-min global timeout once
  useEffect(() => {
    if (isTerminal(pageStatus)) return;

    timeoutRef.current = setTimeout(() => {
      setTimedOut(true);
    }, POLL_TIMEOUT_MS);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (pageStatus?.health_state === 'healthy' && pageStatus.last_ping_at) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    }
  }, [pageStatus]);

  const handleCopy = useCallback(() => {
    if (!pageToken || !launchPublicId || !pagePublicId) return;
    const snippet = buildSnippet(pageToken, launchPublicId, pagePublicId);
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
      toast.success('Snippet copiado');
    });
  }, [pageToken, launchPublicId, pagePublicId]);

  function handleComplete() {
    onComplete({
      completed_at: new Date().toISOString(),
      first_ping_at: pageStatus?.last_ping_at,
    });
  }

  const snippet =
    pageToken && launchPublicId && pagePublicId
      ? buildSnippet(pageToken, launchPublicId, pagePublicId)
      : null;

  const elapsedSeconds = Math.floor(
    (Date.now() - startTimeRef.current) / 1_000,
  );
  const isHealthy = pageStatus?.health_state === 'healthy';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Instale o tracker e verifique</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Cole o snippet abaixo no{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">
            &lt;head&gt;
          </code>{' '}
          da sua landing page.
        </p>
      </div>

      {snippet ? (
        <div className="space-y-2">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs text-amber-800 font-medium">
              O token aparece apenas UMA vez — copie agora.
            </p>
          </div>

          <div className="relative">
            <pre
              aria-label="Snippet de instalacao"
              className="rounded-md bg-muted p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all border"
            >
              {snippet}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCopy}
              aria-label="Copiar snippet de instalacao"
              className="absolute top-2 right-2 h-7 gap-1 text-xs"
            >
              <Copy className="h-3 w-3" aria-hidden="true" />
              {copied ? 'Copiado!' : 'Copiar'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          Pagina nao configurada — pule o passo anterior ou configure uma pagina
          primeiro.
        </div>
      )}

      <div className="rounded-md border p-4 space-y-2">
        <p className="text-sm font-medium">Status da instalacao</p>

        {timedOut && !isHealthy ? (
          <div className="flex items-center gap-2 text-sm text-amber-700">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Nao recebemos resposta apos 5 minutos. Verifique se o snippet foi
              inserido corretamente no{' '}
              <code className="text-xs bg-muted px-1 rounded">
                &lt;head&gt;
              </code>{' '}
              e que o dominio esta na lista permitida.
            </span>
          </div>
        ) : isHealthy ? (
          <div className="flex items-start gap-2 text-sm text-green-700">
            <CheckCircle2
              className="h-4 w-4 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">Tracker instalado</p>
              {pageStatus?.last_ping_at && (
                <p className="text-xs text-muted-foreground">
                  Primeiro PageView recebido em{' '}
                  {new Date(pageStatus.last_ping_at).toLocaleTimeString(
                    'pt-BR',
                  )}
                </p>
              )}
              {pagePublicId && (
                <a
                  href={`/pages/${pagePublicId}`}
                  className="text-xs text-primary underline inline-flex items-center gap-0.5 mt-1"
                  aria-label="Ver detalhes da pagina (abre em nova aba)"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Ver detalhes
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full bg-yellow-400 animate-pulse"
              aria-hidden="true"
            />
            <span>Aguardando primeiro ping... ({elapsedSeconds}s)</span>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={handleComplete}>
          Concluir onboarding
        </Button>
        <Button type="button" variant="ghost" onClick={onSkip}>
          Pular verificacao
        </Button>
      </div>
    </div>
  );
}
