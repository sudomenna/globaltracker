'use client';

import { HealthBadge } from '@/components/health-badge';
import type { HealthState } from '@/components/health-badge';
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
import { CheckCircle, Settings, XCircle } from 'lucide-react';
import Link from 'next/link';
import useSWR from 'swr';

interface ProviderHealth {
  provider: string;
  state: HealthState;
  incident_count?: number;
  metrics_24h?: {
    dispatched: number;
    skipped: number;
    failed: number;
  };
}

interface IntegrationsHealthResponse {
  state: HealthState;
  providers: ProviderHealth[];
}

const PROVIDER_LABELS: Record<string, string> = {
  meta: 'Meta CAPI',
  ga4: 'Google Analytics 4',
  google_ads: 'Google Ads Conversion',
  google_ads_enhanced: 'Google Enhanced Conversions',
  sendflow: 'SendFlow (WhatsApp)',
};

async function fetchIntegrationsHealth(
  url: string,
): Promise<IntegrationsHealthResponse> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';
  const res = await edgeFetch(url, token);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return res.json() as Promise<IntegrationsHealthResponse>;
}

const PROVIDERS = [
  'meta',
  'ga4',
  'google_ads',
  'google_ads_enhanced',
  'sendflow',
] as const;

// SendFlow is webhook-inbound — not part of /v1/health/integrations dispatch
// metrics. Render it with state="unknown" + dedicated copy and no test button.
const INBOUND_ONLY_PROVIDERS = new Set<string>(['sendflow']);

// Health state severity order (higher index = worse)
const STATE_SEVERITY: HealthState[] = ['unknown', 'healthy', 'degraded', 'unhealthy'];

function worstState(a: HealthState, b: HealthState): HealthState {
  const ia = STATE_SEVERITY.indexOf(a);
  const ib = STATE_SEVERITY.indexOf(b);
  return ia >= ib ? a : b;
}

// Aggregate backend destinations into the virtual provider ids shown in the UI.
// Backend returns `google_ads_conversion` + `google_enhancement`;
// we merge them into `google_ads` for the list card.
function buildProviderMap(
  providers: ProviderHealth[],
): Map<string, ProviderHealth> {
  const map = new Map<string, ProviderHealth>(
    providers.map((p) => [p.provider, p]),
  );

  const conv = map.get('google_ads_conversion');
  const enh = map.get('google_enhancement');

  if (conv != null || enh != null) {
    const state = worstState(
      conv?.state ?? 'unknown',
      enh?.state ?? 'unknown',
    );
    const metrics_24h =
      conv?.metrics_24h != null || enh?.metrics_24h != null
        ? {
            dispatched:
              (conv?.metrics_24h?.dispatched ?? 0) +
              (enh?.metrics_24h?.dispatched ?? 0),
            skipped:
              (conv?.metrics_24h?.skipped ?? 0) +
              (enh?.metrics_24h?.skipped ?? 0),
            failed:
              (conv?.metrics_24h?.failed ?? 0) +
              (enh?.metrics_24h?.failed ?? 0),
          }
        : undefined;
    map.set('google_ads', { provider: 'google_ads', state, metrics_24h });
  }

  return map;
}

interface IntegrationsListClientProps {
  role: string;
}

export function IntegrationsListClient({
  role: _role,
}: IntegrationsListClientProps) {
  const { data, error, isLoading, mutate } = useSWR<IntegrationsHealthResponse>(
    '/v1/health/integrations',
    fetchIntegrationsHealth,
    {
      refreshInterval: 60_000,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return;
        setTimeout(() => revalidate({ retryCount }), 5_000);
      },
    },
  );

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {PROVIDERS.map((p) => (
          <Card key={p}>
            <CardHeader className="pb-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-24 mt-1" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-9 w-28 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error != null || data == null) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Não foi possível carregar o status das integrações.
        </CardContent>
      </Card>
    );
  }

  const providerMap = buildProviderMap(data.providers);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {PROVIDERS.map((providerId) => {
        const isInboundOnly = INBOUND_ONLY_PROVIDERS.has(providerId);
        const health = providerMap.get(providerId);
        const state: HealthState = isInboundOnly
          ? 'unknown'
          : (health?.state ?? 'unknown');
        const metrics = isInboundOnly ? undefined : health?.metrics_24h;
        const label = PROVIDER_LABELS[providerId] ?? providerId;

        return (
          <Card key={providerId} className="flex flex-col">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{label}</CardTitle>
                {!isInboundOnly && (
                  <HealthBadge
                    size="sm"
                    state={state}
                    incidentCount={health?.incident_count}
                  />
                )}
              </div>
              <CardDescription>
                {isInboundOnly
                  ? 'Webhook inbound — sem métricas de saúde'
                  : state === 'unknown'
                    ? 'Nenhuma tentativa registrada'
                    : 'Últimas 24 horas'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 flex-1">
              {isInboundOnly ? (
                <p className="text-sm text-muted-foreground">
                  Webhook inbound — verifique recebimentos no detalhe.
                </p>
              ) : metrics != null ? (
                <ul
                  className="space-y-1 text-sm"
                  aria-label={`Métricas de ${label}`}
                >
                  <li className="flex items-center gap-1.5 text-green-600">
                    <CheckCircle
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{metrics.dispatched} enviados</span>
                  </li>
                  {metrics.skipped > 0 && (
                    <li className="flex items-center gap-1.5 text-yellow-600">
                      <span
                        className="h-3.5 w-3.5 shrink-0 flex items-center justify-center text-xs font-bold"
                        aria-hidden="true"
                      >
                        ⚠
                      </span>
                      <span>{metrics.skipped} ignorados</span>
                    </li>
                  )}
                  {metrics.failed > 0 && (
                    <li className="flex items-center gap-1.5 text-red-600">
                      <XCircle
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{metrics.failed} falharam</span>
                    </li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nenhum evento registrado — dispare um teste para validar.
                </p>
              )}
              <div className="flex gap-2 mt-auto pt-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/integrations/${providerId}`}>
                    <Settings className="h-4 w-4 mr-1.5" aria-hidden="true" />
                    Configurar
                  </Link>
                </Button>
                {!isInboundOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void mutate()}
                    aria-label={`Testar agora ${label}`}
                  >
                    Testar agora
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
