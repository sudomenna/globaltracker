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
import type { EventConfig } from '@/lib/page-role-defaults';
import {
  Check,
  ChevronLeft,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { DiagnosticsPanel } from './diagnostics-panel';

const CANONICAL_EVENT_OPTIONS = [
  'PageView',
  'Lead',
  'ViewContent',
  'InitiateCheckout',
  'Purchase',
  'Contact',
  'CompleteRegistration',
] as const;

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
  initialEventConfig?: EventConfig | null;
  initialUrl?: string | null;
  initialAllowedDomains?: string[];
}

const TRACKER_CDN_URL =
  process.env.NEXT_PUBLIC_TRACKER_CDN_URL ??
  'https://pub-e224c543d78644699af01a135279a5e2.r2.dev/tracker.js';

function buildHeadSnippet(
  pageToken: string,
  pagePublicId: string,
  launchPublicId: string,
  edgeUrl?: string,
) {
  const edgeAttr = edgeUrl ? `\n  data-edge-url="${edgeUrl}"` : '';
  return `<script
  src="${TRACKER_CDN_URL}"
  data-site-token="${pageToken}"
  data-launch-public-id="${launchPublicId}"
  data-page-public-id="${pagePublicId}"${edgeAttr}>
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
  initialEventConfig,
  initialUrl,
  initialAllowedDomains = [],
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
  const [eventConfig, setEventConfig] = useState<EventConfig>(() => ({
    canonical: initialEventConfig?.canonical ?? [],
    custom: initialEventConfig?.custom ?? [],
  }));
  const [customEventsText, setCustomEventsText] = useState(() =>
    (initialEventConfig?.custom ?? []).join('\n'),
  );
  const [isSavingEventConfig, setIsSavingEventConfig] = useState(false);
  const [eventConfigSaveError, setEventConfigSaveError] = useState<
    string | null
  >(null);
  const [eventConfigSaved, setEventConfigSaved] = useState(false);

  // Page configuration (url + allowed_domains)
  const [pageUrl, setPageUrl] = useState(initialUrl ?? '');
  const [allowedDomains, setAllowedDomains] = useState<string[]>(initialAllowedDomains);
  const [newDomain, setNewDomain] = useState('');
  const [isSavingPageConfig, setIsSavingPageConfig] = useState(false);
  const [pageConfigSaveError, setPageConfigSaveError] = useState<string | null>(null);
  const [pageConfigSaved, setPageConfigSaved] = useState(false);

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

  function handleCanonicalToggle(eventName: string) {
    setEventConfig((prev) => {
      const has = prev.canonical.includes(eventName);
      return {
        ...prev,
        canonical: has
          ? prev.canonical.filter((e) => e !== eventName)
          : [...prev.canonical, eventName],
      };
    });
  }

  function handleCustomEventsChange(text: string) {
    setCustomEventsText(text);
    const custom = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith('custom:') ? line : `custom:${line}`));
    setEventConfig((prev) => ({ ...prev, custom }));
  }

  async function handleSaveEventConfig() {
    setIsSavingEventConfig(true);
    setEventConfigSaveError(null);
    setEventConfigSaved(false);

    const res = await fetch(`${baseUrl}/v1/pages/${pagePublicId}?launch_public_id=${launchPublicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_config: eventConfig }),
    });

    setIsSavingEventConfig(false);

    if (!res.ok) {
      const errorId = res.headers.get('X-Request-Id') ?? 'desconhecido';
      setEventConfigSaveError(
        `Falha ao salvar configuração. ID do erro: ${errorId}`,
      );
      return;
    }

    setEventConfigSaved(true);
    setTimeout(() => setEventConfigSaved(false), 2_000);
  }

  function handleScrollToSnippet() {
    snippetSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  function handleAddDomain() {
    const domain = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain || allowedDomains.includes(domain)) return;
    setAllowedDomains((prev) => [...prev, domain]);
    setNewDomain('');
  }

  function handleRemoveDomain(domain: string) {
    setAllowedDomains((prev) => prev.filter((d) => d !== domain));
  }

  async function handleSavePageConfig() {
    setIsSavingPageConfig(true);
    setPageConfigSaveError(null);
    setPageConfigSaved(false);

    const body: Record<string, unknown> = { allowed_domains: allowedDomains };
    if (pageUrl.trim()) body.url = pageUrl.trim();
    else body.url = null;

    const res = await fetch(
      `${baseUrl}/v1/pages/${pagePublicId}?launch_public_id=${launchPublicId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    setIsSavingPageConfig(false);

    if (!res.ok) {
      const errorId = res.headers.get('X-Request-Id') ?? 'desconhecido';
      setPageConfigSaveError(`Falha ao salvar. ID do erro: ${errorId}`);
      return;
    }

    setPageConfigSaved(true);
    setTimeout(() => setPageConfigSaved(false), 2_000);
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
      <Link
        href={`/launches/${launchPublicId}?tab=pages`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Voltar para o lançamento
      </Link>

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

      {/* Configuração da página */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração da página</CardTitle>
          <CardDescription>
            URL da landing page e domínios autorizados a disparar eventos.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="page-url" className="text-sm font-medium">
              URL da página
            </label>
            <input
              id="page-url"
              type="url"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
              placeholder="https://seudominio.com/captura"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Domínios autorizados</p>
            <p className="text-xs text-muted-foreground">
              Apenas requisições originadas desses domínios serão aceitas. Cole sem protocolo (ex:{' '}
              <code className="font-mono text-xs bg-muted px-1 rounded">cneeducacao.com</code>).
            </p>

            {allowedDomains.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {allowedDomains.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs font-mono"
                  >
                    {d}
                    <button
                      type="button"
                      onClick={() => handleRemoveDomain(d)}
                      aria-label={`Remover domínio ${d}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDomain(); } }}
                placeholder="cneeducacao.com"
                className="flex h-8 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddDomain}
                disabled={!newDomain.trim()}
              >
                Adicionar
              </Button>
            </div>
          </div>

          {pageConfigSaveError && (
            <p className="text-sm text-destructive">{pageConfigSaveError}</p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSavePageConfig}
            disabled={isSavingPageConfig}
            className="gap-1.5"
          >
            {pageConfigSaved ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Salvo!
              </>
            ) : (
              <>
                <Save className="h-4 w-4" aria-hidden="true" />
                {isSavingPageConfig ? 'Salvando...' : 'Salvar configuração'}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Diagnostics panel — A.4: contextual diagnosis for origin_not_allowed, invalid_token, no recent ping */}
      {status != null && (
        <DiagnosticsPanel
          issues={status.recent_issues}
          lastPingAt={status.last_ping_at}
          healthState={status.health_state}
          onScrollToSnippet={handleScrollToSnippet}
          onAddDomain={(domain) => {
            setAllowedDomains((prev) => prev.includes(domain) ? prev : [...prev, domain]);
          }}
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
          <CardTitle className="text-base">
            Captura de leads do formulário
          </CardTitle>
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
            <label
              htmlFor="form-selector-detail"
              className="text-xs font-medium text-muted-foreground"
            >
              Seletor CSS do formulário
            </label>
            <input
              id="form-selector-detail"
              value={formSelector}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setFormSelector(e.target.value)
              }
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
              await navigator.clipboard.writeText(
                buildBodySnippet(formSelector),
              );
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

      {/* Configuração de eventos */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração de eventos</CardTitle>
          <CardDescription>
            Selecione quais eventos canônicos esta página deve disparar e
            adicione eventos customizados se necessário.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset>
            <legend className="text-sm font-medium mb-2">
              Eventos canônicos
            </legend>
            <div className="space-y-2">
              {CANONICAL_EVENT_OPTIONS.map((eventName) => (
                <label
                  key={eventName}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={eventConfig.canonical.includes(eventName)}
                    onChange={() => handleCanonicalToggle(eventName)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm font-mono">{eventName}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <label
              htmlFor="custom-events-config"
              className="text-sm font-medium"
            >
              Eventos customizados{' '}
              <span className="font-normal text-muted-foreground">
                (opcional)
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Um evento por linha. O prefixo{' '}
              <code className="font-mono text-xs bg-muted px-1 rounded">
                custom:
              </code>{' '}
              é adicionado automaticamente.
            </p>
            <textarea
              id="custom-events-config"
              rows={3}
              value={customEventsText}
              onChange={(e) => handleCustomEventsChange(e.target.value)}
              placeholder="watched_class_1&#10;quiz_completed"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
            />
          </div>

          {eventConfigSaveError && (
            <p className="text-sm text-destructive">{eventConfigSaveError}</p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSaveEventConfig}
            disabled={isSavingEventConfig}
            className="gap-1.5"
          >
            {eventConfigSaved ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                Salvo!
              </>
            ) : (
              <>
                <Save className="h-4 w-4" aria-hidden="true" />
                {isSavingEventConfig ? 'Salvando...' : 'Salvar configuração'}
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
