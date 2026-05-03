'use client';

import { HealthBadge } from '@/components/health-badge';
import type { HealthState } from '@/components/health-badge';
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
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, Clipboard, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { DiagnosticsPanel } from './diagnostics-panel';

interface PageStatus {
  page_public_id: string;
  health_state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  last_ping_at: string | null;
  events_today: number;
  events_last_24h: number;
  token_status: 'active' | 'rotating' | 'expired';
  token_rotates_at: string | null;
  recent_issues: Array<{
    type: string;
    domain?: string;
    count: number;
    last_seen_at: string;
  }>;
}

interface Props {
  launchPublicId: string;
  pagePublicId: string;
  accessToken: string;
  initialStatus: PageStatus | null;
}

function buildHeadSnippet(
  pageToken: string,
  pagePublicId: string,
  launchPublicId: string,
) {
  return `<script
  src="https://cdn.globaltracker.io/tracker.js"
  data-site-token="${pageToken}"
  data-launch-public-id="${launchPublicId}"
  data-page-public-id="${pagePublicId}">
</script>`;
}

function buildBodySnippet(formSelector: string) {
  return `<script>
document.addEventListener('DOMContentLoaded', function () {
  var form = document.querySelector('${formSelector}');
  if (!form) return;
  form.addEventListener('submit', function () {
    function val(sels) {
      for (var i = 0; i < sels.length; i++) {
        var el = form.querySelector(sels[i]);
        if (el && el.value) return el.value;
      }
    }
    window.Funil.identify({
      email: val(['[name="email"]', '[type="email"]', '[name="e-mail"]']),
      name: val(['[name="nome"]', '[name="name"]', '[name="primeiro_nome"]']),
      phone: val(['[name="telefone"]', '[name="celular"]', '[name="whatsapp"]', '[name="phone"]', '[name="fone"]']),
    });
  });
});
<\/script>`;
}

const MASKED_TOKEN = '••••••••••••••••••••••';

export function PageDetailClient({
  launchPublicId,
  pagePublicId,
  accessToken,
  initialStatus,
}: Props) {
  const [tokenVisible, setTokenVisible] = useState(false);
  // pageToken: loaded from localStorage (saved on creation/rotation) or set after rotation.
  const [pageToken, setPageToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(`gt:token:${pagePublicId}`);
  });
  const [copied, setCopied] = useState(false);
  const [bodyCopied, setBodyCopied] = useState(false);
  const [formSelector, setFormSelector] = useState('form');
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [rotateConfirmInput, setRotateConfirmInput] = useState('');
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const statusLiveRegionRef = useRef<HTMLSpanElement>(null);
  const snippetSectionRef = useRef<HTMLDivElement>(null);

  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  const fetcher = useCallback(
    async (url: string) => {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Erro ao buscar status');
      return res.json() as Promise<PageStatus>;
    },
    [accessToken],
  );

  const hasPinged = initialStatus?.last_ping_at != null;
  // Aggressive polling until first ping; slow after that (docs/70-ux/09-interaction-patterns.md §polling)
  const [refreshInterval, setRefreshInterval] = useState(
    hasPinged ? 60_000 : 5_000,
  );

  const { data: status, error: statusError } = useSWR<PageStatus>(
    `${baseUrl}/v1/pages/${pagePublicId}/status`,
    fetcher,
    {
      fallbackData: initialStatus ?? undefined,
      refreshInterval,
      revalidateOnFocus: false,
    },
  );

  // Switch to slow polling once first ping arrives
  useEffect(() => {
    if (status?.last_ping_at != null && refreshInterval === 5_000) {
      setRefreshInterval(60_000);
      if (statusLiveRegionRef.current) {
        statusLiveRegionRef.current.textContent =
          'Tracker conectado e funcionando';
      }
    }
  }, [status?.last_ping_at, refreshInterval]);

  const connected = status?.last_ping_at != null;

  async function handleCopySnippet() {
    const token = pageToken ?? MASKED_TOKEN;
    const snippet = buildHeadSnippet(token, pagePublicId, launchPublicId);
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  async function handleRotateToken() {
    setIsRotating(true);
    setRotateError(null);

    const res = await fetch(
      `${baseUrl}/v1/pages/${pagePublicId}/rotate-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    setIsRotating(false);

    if (!res.ok) {
      const errorId = res.headers.get('X-Request-Id') ?? 'desconhecido';
      setRotateError(`Falha ao rotacionar token. ID do erro: ${errorId}`);
      return;
    }

    const data = (await res.json()) as { page_token: string };
    setPageToken(data.page_token);
    localStorage.setItem(`gt:token:${pagePublicId}`, data.page_token);
    setTokenVisible(true);
    setRotateDialogOpen(false);
    setRotateConfirmInput('');
  }

  const rotateConfirmPhrase = `ROTACIONAR ${pagePublicId.toUpperCase()}`;
  const canConfirmRotate = rotateConfirmInput === rotateConfirmPhrase;

  function handleScrollToSnippet() {
    snippetSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  function handleAddDomain(_domain: string) {
    // TODO: call PATCH /v1/launches/:launchPublicId/pages/:pagePublicId
    // to append domain to allowed_domains once endpoint is available
  }

  const displayToken = tokenVisible && pageToken ? pageToken : MASKED_TOKEN;
  const snippet = buildHeadSnippet(
    pageToken ?? MASKED_TOKEN,
    pagePublicId,
    launchPublicId,
  );

  const healthState: HealthState =
    status == null ? 'loading' : (status.health_state as HealthState);

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold font-mono">{pagePublicId}</h1>
            <p className="text-sm text-muted-foreground">
              Lançamento: {launchPublicId}
            </p>
          </div>
          <HealthBadge state={healthState} size="sm" />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRotateDialogOpen(true)}
          className="gap-1.5"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Rotacionar token
        </Button>
      </div>

      {/* Status card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status de instalação</CardTitle>
        </CardHeader>
        <CardContent>
          {status == null && !statusError && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
          )}

          {statusError && (
            <p className="text-sm text-muted-foreground">
              Não foi possível verificar status — tentando novamente em 5s
            </p>
          )}

          {status != null && !statusError && (
            <div className="space-y-3">
              {/* Live region for screen readers — docs/70-ux/04-screen-page-registration.md §9 */}
              <span
                ref={statusLiveRegionRef}
                aria-live="polite"
                className="sr-only"
              />

              {!connected ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse"
                    aria-hidden="true"
                  />
                  Aguardando primeiro ping...
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Conectado
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Eventos hoje</span>
                  <p className="font-medium">{status.events_today}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Últimas 24h</span>
                  <p className="font-medium">{status.events_last_24h}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Token</span>
                  <p className="font-medium capitalize">
                    {status.token_status}
                  </p>
                </div>
                {status.token_rotates_at && (
                  <div>
                    <span className="text-muted-foreground">Rotaciona em</span>
                    <p className="font-medium">
                      {new Date(status.token_rotates_at).toLocaleDateString(
                        'pt-BR',
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Diagnostics panel — A.4: contextual diagnosis for origin_not_allowed, invalid_token, no recent ping */}
      {status != null && (
        <DiagnosticsPanel
          issues={status.recent_issues}
          lastPingAt={status.last_ping_at}
          healthState={status.health_state}
          onScrollToSnippet={handleScrollToSnippet}
          onAddDomain={handleAddDomain}
        />
      )}

      {/* Snippet de instalação */}
      <Card id="snippet-section" ref={snippetSectionRef}>
        <CardHeader>
          <CardTitle className="text-base">Snippet de instalação</CardTitle>
          <CardDescription>
            Cole no{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              &lt;head&gt;
            </code>{' '}
            da landing page.
            {!pageToken && (
              <span className="block mt-1 text-amber-600 dark:text-amber-400">
                Token mascarado. Rotacione para obter um novo token em claro.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative rounded-md border bg-muted/50 p-3 font-mono text-xs overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">
              {buildHeadSnippet(displayToken, pagePublicId, launchPublicId)}
            </pre>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopySnippet}
              aria-label="Copiar snippet de instalação"
              className="gap-1.5"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Copiado!
                </>
              ) : (
                <>
                  <Clipboard className="h-4 w-4" aria-hidden="true" />
                  Copiar snippet
                </>
              )}
            </Button>

            {pageToken && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTokenVisible((v) => !v)}
                aria-label={tokenVisible ? 'Ocultar token' : 'Mostrar token'}
                className="gap-1.5"
              >
                {tokenVisible ? (
                  <>
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                    Ocultar
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" aria-hidden="true" />
                    Mostrar
                  </>
                )}
              </Button>
            )}
          </div>

          {/* Token mascarado após primeiro ping — spec §3 */}
          {connected && !pageToken && (
            <p
              className="text-xs text-muted-foreground font-mono"
              aria-describedby="token-info"
            >
              Token atual: {MASKED_TOKEN}
            </p>
          )}
          {!pageToken && (
            <p id="token-info" className="text-xs text-muted-foreground">
              Para ver o token em claro, rotacione-o. O token antigo fica válido
              por 14 dias.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Snippet do body — captura de leads do formulário */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Captura de leads do formulário</CardTitle>
          <CardDescription>
            Cole antes do{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              &lt;/body&gt;
            </code>{' '}
            da landing page. Ajuste o seletor se necessário.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="form-selector-detail" className="text-xs font-medium text-muted-foreground">
              Seletor CSS do formulário
            </label>
            <input
              id="form-selector-detail"
              value={formSelector}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormSelector(e.target.value)}
              placeholder="form, #meu-form, .form-captura"
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="relative rounded-md border bg-muted/50 p-3 font-mono text-xs overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">
              {buildBodySnippet(formSelector)}
            </pre>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              await navigator.clipboard.writeText(buildBodySnippet(formSelector));
              setBodyCopied(true);
              setTimeout(() => setBodyCopied(false), 2_000);
            }}
            aria-label="Copiar script de captura de formulário"
            className="gap-1.5"
          >
            {bodyCopied ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Copiado!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copiar script
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* AlertDialog — confirmação destrutiva de rotação de token */}
      {/* Padrão §D de docs/70-ux/09-interaction-patterns.md */}
      <AlertDialog
        open={rotateDialogOpen}
        onOpenChange={(open) => {
          setRotateDialogOpen(open);
          if (!open) {
            setRotateConfirmInput('');
            setRotateError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Rotacionar token de rastreamento
            </AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação gera um <strong>novo token</strong>. O token atual entra
              em modo <em>rotating</em> e expira em <strong>14 dias</strong>.
              Você precisará atualizar o snippet em todas as páginas onde ele
              está instalado.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-2 my-2">
            <p className="text-sm">
              Para confirmar, digite:{' '}
              <span className="font-mono font-medium">
                {rotateConfirmPhrase}
              </span>
            </p>
            <input
              type="text"
              value={rotateConfirmInput}
              onChange={(e) => setRotateConfirmInput(e.target.value)}
              placeholder={rotateConfirmPhrase}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Digite ${rotateConfirmPhrase} para confirmar`}
            />
            {rotateError && (
              <p className="text-sm text-destructive">{rotateError}</p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRotateToken}
              disabled={!canConfirmRotate || isRotating}
            >
              {isRotating ? 'Rotacionando...' : 'Rotacionar token'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
