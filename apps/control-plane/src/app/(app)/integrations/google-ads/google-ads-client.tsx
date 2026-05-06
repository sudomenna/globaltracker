'use client';

import { HealthBadge } from '@/components/health-badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import useSWR from 'swr';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GoogleAdsConfig {
  oauth_token_state?: 'pending' | 'connected' | 'expired';
  customer_id?: string;
  login_customer_id?: string;
  conversion_actions?: Record<string, string | null>;
  enabled?: boolean;
}

interface WorkspaceConfigResponse {
  config: {
    integrations?: {
      google_ads?: GoogleAdsConfig;
    };
    [key: string]: unknown;
  };
  request_id?: string;
}

interface ConversionAction {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface ConversionActionsResponse {
  conversion_actions: ConversionAction[];
  request_id?: string;
}

interface OAuthStartResponse {
  authorize_url: string;
  request_id: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// BR-EVENT: canonical event names supported for conversion mapping
const CANONICAL_EVENT_NAMES = [
  'Lead',
  'Purchase',
  'InitiateCheckout',
  'AddToCart',
  'ViewContent',
  'CompleteRegistration',
  'Subscribe',
  'StartTrial',
  'AddPaymentInfo',
  'Schedule',
  'SubmitApplication',
  'Contact',
  'Search',
  'AddToWishlist',
] as const;

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchWithAuth<T>(path: string): Promise<T> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';
  const res = await edgeFetch(path, token);
  if (!res.ok) {
    const err = new Error(`fetch ${path} failed: ${res.status}`);
    (err as Error & { status: number; body: unknown }).status = res.status;
    try {
      (err as Error & { status: number; body: unknown }).body =
        await res.json();
    } catch {
      (err as Error & { status: number; body: unknown }).body = null;
    }
    throw err;
  }
  return res.json() as Promise<T>;
}

async function patchWithAuth(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';
  const res = await edgeFetch(path, token, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function formatCustomerId(raw: string): string {
  // Format 10-digit string as XXX-XXX-XXXX
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 10) return raw;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ─── Card 1: OAuth Connection ─────────────────────────────────────────────────

function OAuthCard({
  config,
  configLoading,
  configError,
}: {
  config: GoogleAdsConfig | undefined;
  configLoading: boolean;
  configError: unknown;
}) {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const oauthState = config?.oauth_token_state;
  const customerId = config?.customer_id;

  const badgeState =
    oauthState === 'connected'
      ? 'healthy'
      : oauthState === 'expired'
        ? 'unhealthy'
        : 'unknown';

  const badgeLabel =
    oauthState === 'connected'
      ? 'Conectado'
      : oauthState === 'expired'
        ? 'Token expirado'
        : 'Não conectado';

  const buttonLabel =
    oauthState === 'expired' ? 'Reconectar Google Ads' : 'Conectar Google Ads';

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const supabase = createSupabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const res = await edgeFetch(
        '/v1/integrations/google/oauth/start',
        token,
      );
      if (!res.ok) {
        throw new Error(`Erro ao iniciar OAuth: ${res.status}`);
      }
      const data = (await res.json()) as OAuthStartResponse;
      window.location.href = data.authorize_url;
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Erro ao conectar. Tente novamente.',
      );
      setConnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Conexão OAuth</CardTitle>
          {!configLoading && configError == null && (
            <HealthBadge size="sm" state={badgeState} label={badgeLabel} />
          )}
        </div>
        <CardDescription>
          Autorize o GlobalTracker a acessar sua conta Google Ads via OAuth 2.0.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {configLoading && <Skeleton className="h-9 w-full" />}

        {!configLoading && configError != null && (
          <p className="text-sm text-red-600" role="alert">
            Não foi possível ler o estado da conexão.
          </p>
        )}

        {!configLoading && configError == null && (
          <>
            {oauthState === 'connected' && customerId && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Customer ID
                </p>
                <code className="block rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono">
                  {formatCustomerId(customerId)}
                </code>
              </div>
            )}

            <Button
              size="sm"
              onClick={() => void handleConnect()}
              disabled={connecting}
            >
              {connecting && (
                <Loader2
                  className="h-4 w-4 mr-1.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              {buttonLabel}
            </Button>

            {connectError != null && (
              <p className="text-sm text-red-600" role="alert">
                {connectError}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Card 2: Customer ID ──────────────────────────────────────────────────────

function CustomerIdCard({
  canEdit,
  config,
  mutateConfig,
}: {
  canEdit: boolean;
  config: GoogleAdsConfig | undefined;
  mutateConfig: () => void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: 'idle' }
    | { kind: 'success' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Sync local value with config on load
  useEffect(() => {
    if (config?.customer_id) {
      setValue(config.customer_id);
    }
  }, [config?.customer_id]);

  const isValid = /^\d{10}$/.test(value);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    setSubmitting(true);
    setFeedback({ kind: 'idle' });
    try {
      const result = await patchWithAuth('/v1/workspace/config', {
        integrations: { google_ads: { customer_id: value } },
      });
      if (result.ok) {
        setFeedback({ kind: 'success' });
        mutateConfig();
      } else {
        const json = result.json as { message?: string } | null;
        setFeedback({
          kind: 'error',
          message: json?.message ?? 'Não foi possível salvar.',
        });
      }
    } catch {
      setFeedback({
        kind: 'error',
        message: 'Não foi possível conectar ao servidor.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!canEdit || config?.oauth_token_state !== 'connected') return null;

  const invalidInput = value.length > 0 && !isValid;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Customer ID</CardTitle>
        <CardDescription>
          ID numérico de 10 dígitos da conta Google Ads (sem hífens).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-3" onSubmit={(e) => void handleSave(e)}>
          <div className="space-y-1">
            <label htmlFor="google-ads-customer-id" className="text-sm font-medium">
              Customer ID
            </label>
            <input
              id="google-ads-customer-id"
              type="text"
              inputMode="numeric"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setFeedback({ kind: 'idle' });
              }}
              placeholder="0000000000"
              aria-invalid={invalidInput}
              aria-describedby="google-ads-customer-id-hint"
              className={cn(
                'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm font-mono',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                invalidInput && 'border-destructive',
              )}
            />
            <p
              id="google-ads-customer-id-hint"
              className="text-xs text-muted-foreground"
            >
              10 dígitos numéricos, sem hífens.
              {invalidInput && (
                <span className="text-destructive"> Formato inválido.</span>
              )}
            </p>
          </div>
          <Button type="submit" size="sm" disabled={!isValid || submitting}>
            {submitting && (
              <Loader2
                className="h-4 w-4 mr-1.5 animate-spin"
                aria-hidden="true"
              />
            )}
            Salvar
          </Button>
        </form>

        <div aria-live="polite" className="min-h-[1rem]">
          {feedback.kind === 'success' && (
            <output className="text-sm text-green-600 block">
              Customer ID salvo com sucesso.
            </output>
          )}
        </div>
        {feedback.kind === 'error' && (
          <p className="text-sm text-red-600" role="alert">
            {feedback.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Card 3: Conversion Mapping ───────────────────────────────────────────────

function ConversionMappingCard({
  canEdit,
  config,
  mutateConfig,
}: {
  canEdit: boolean;
  config: GoogleAdsConfig | undefined;
  mutateConfig: () => void;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: 'idle' }
    | { kind: 'success' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const {
    data: actionsData,
    error: actionsError,
    isLoading: actionsLoading,
  } = useSWR<ConversionActionsResponse>(
    config?.oauth_token_state === 'connected' && config?.customer_id
      ? '/v1/integrations/google/conversion-actions'
      : null,
    fetchWithAuth,
  );

  // Hydrate selections from config
  useEffect(() => {
    const saved = config?.conversion_actions ?? {};
    const next: Record<string, string> = {};
    for (const name of CANONICAL_EVENT_NAMES) {
      next[name] = saved[name] ?? '';
    }
    setSelections(next);
  }, [config?.conversion_actions]);

  async function handleSave() {
    setSubmitting(true);
    setFeedback({ kind: 'idle' });
    try {
      const conversion_actions: Record<string, string | null> = {};
      for (const name of CANONICAL_EVENT_NAMES) {
        const val = selections[name] ?? '';
        conversion_actions[name] = val === '' ? null : val;
      }
      const result = await patchWithAuth('/v1/workspace/config', {
        integrations: { google_ads: { conversion_actions } },
      });
      if (result.ok) {
        setFeedback({ kind: 'success' });
        mutateConfig();
      } else {
        const json = result.json as { message?: string } | null;
        setFeedback({
          kind: 'error',
          message: json?.message ?? 'Não foi possível salvar.',
        });
      }
    } catch {
      setFeedback({
        kind: 'error',
        message: 'Não foi possível conectar ao servidor.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!canEdit || config?.oauth_token_state !== 'connected' || !config?.customer_id) {
    return null;
  }

  // Determine error code from actionsError
  const errBody = actionsError
    ? (actionsError as Error & { body: unknown }).body
    : null;
  const errCode =
    errBody != null && typeof errBody === 'object'
      ? (errBody as Record<string, unknown>).code
      : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Mapeamento de conversões</CardTitle>
        <CardDescription>
          Associe eventos canônicos do GlobalTracker a conversion actions do
          Google Ads.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {actionsLoading && (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {!actionsLoading && actionsError != null && (
          <p className="text-sm text-red-600" role="alert">
            {errCode === 'not_configured' || errCode === 'oauth_pending'
              ? 'Configure a conexão OAuth primeiro.'
              : errCode === 'token_revoked'
                ? 'Token revogado — reconecte.'
                : 'Não foi possível carregar as conversion actions.'}
          </p>
        )}

        {!actionsLoading && actionsError == null && actionsData != null && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-separate border-spacing-y-1">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="font-medium pr-4 pb-2">
                      Evento canonical
                    </th>
                    <th scope="col" className="font-medium pb-2">
                      Conversion Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {CANONICAL_EVENT_NAMES.map((eventName) => (
                    <tr key={eventName}>
                      <td className="pr-4 py-1">
                        <code className="text-xs font-mono">{eventName}</code>
                      </td>
                      <td className="py-1">
                        <select
                          value={selections[eventName] ?? ''}
                          onChange={(e) => {
                            setSelections((prev) => ({
                              ...prev,
                              [eventName]: e.target.value,
                            }));
                            setFeedback({ kind: 'idle' });
                          }}
                          aria-label={`Conversion action para ${eventName}`}
                          className={cn(
                            'flex h-9 w-64 rounded-md border border-input bg-background px-2 py-1 text-sm',
                            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          )}
                        >
                          <option value="">(não mapear)</option>
                          {actionsData.conversion_actions.map((action) => (
                            <option key={action.id} value={action.id}>
                              {action.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              disabled={submitting}
            >
              {submitting && (
                <Loader2
                  className="h-4 w-4 mr-1.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              Salvar mapeamento
            </Button>

            <div aria-live="polite" className="min-h-[1rem]">
              {feedback.kind === 'success' && (
                <output className="text-sm text-green-600 block">
                  Mapeamento salvo com sucesso.
                </output>
              )}
            </div>
            {feedback.kind === 'error' && (
              <p className="text-sm text-red-600" role="alert">
                {feedback.message}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Top-level export ─────────────────────────────────────────────────────────

interface GoogleAdsClientProps {
  canEdit: boolean;
}

export function GoogleAdsClient({ canEdit }: GoogleAdsClientProps) {
  const {
    data: configData,
    error: configError,
    isLoading: configLoading,
    mutate: mutateConfig,
  } = useSWR<WorkspaceConfigResponse>('/v1/workspace/config', fetchWithAuth);

  const googleAdsConfig = configData?.config?.integrations?.google_ads;

  return (
    <div className="space-y-4">
      <OAuthCard
        config={googleAdsConfig}
        configLoading={configLoading}
        configError={configError}
      />
      <CustomerIdCard
        canEdit={canEdit}
        config={googleAdsConfig}
        mutateConfig={() => void mutateConfig()}
      />
      <ConversionMappingCard
        canEdit={canEdit}
        config={googleAdsConfig}
        mutateConfig={() => void mutateConfig()}
      />
    </div>
  );
}
