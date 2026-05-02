'use client';

import { HealthBadge } from '@/components/health-badge';
import type { HealthState } from '@/components/health-badge';
import { TooltipHelp } from '@/components/tooltip-help';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { cn } from '@/lib/utils';
import { CheckCircle, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';

// Shape per GET /v1/health/integrations response
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

// Shape per POST /v1/integrations/:provider/test
interface TestPhase {
  name: string;
  ok: boolean;
  latency_ms?: number;
}

interface TestResponse {
  status: 'ok' | 'error';
  latency_ms?: number;
  phases: TestPhase[];
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; result: TestResponse }
  | { kind: 'error'; result: TestResponse; message: string };

const FIELD_TOOLTIPS: Record<string, string> = {
  pixel_id:
    'Identificador único do seu Meta Pixel. Encontre em business.facebook.com → Events Manager → Pixel.',
  access_token:
    'Token de acesso da Conversions API (CAPI). Gerado em Meta Events Manager → seu Pixel → Configurações → Conversions API.',
  test_event_code:
    'Código de teste do Meta. Use para validar eventos sem afetar dados de produção. Encontre em Meta Events Manager → Testar Eventos.',
  measurement_id:
    'Identificador do fluxo de dados GA4. Começa com "G-". Encontre em Google Analytics → Administrador → Fluxos de dados.',
  api_secret:
    'Chave secreta da Measurement Protocol API do GA4. Gerada em Google Analytics → Administrador → Fluxos de dados → Secrets para API.',
};

const CREDENTIAL_FIELDS: Record<
  string,
  {
    label: string;
    field: string;
    masked?: boolean;
    readOnly?: boolean;
    optional?: boolean;
  }[]
> = {
  meta: [
    { label: 'Pixel ID', field: 'pixel_id' },
    { label: 'Access Token', field: 'access_token', masked: true },
    { label: 'Test Event Code', field: 'test_event_code', optional: true },
  ],
  ga4: [
    { label: 'Measurement ID', field: 'measurement_id' },
    { label: 'API Secret', field: 'api_secret', masked: true },
  ],
  google_ads: [
    { label: 'Customer ID', field: 'customer_id', readOnly: true },
    {
      label: 'Developer Token',
      field: 'developer_token',
      masked: true,
      readOnly: true,
    },
  ],
  google_ads_enhanced: [
    { label: 'Customer ID', field: 'customer_id', readOnly: true },
    {
      label: 'Developer Token',
      field: 'developer_token',
      masked: true,
      readOnly: true,
    },
  ],
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

interface IntegrationDetailClientProps {
  provider: string;
  providerLabel: string;
  deepLinks: { label: string; href: string }[];
  canEdit: boolean;
  role: string;
}

export function IntegrationDetailClient({
  provider,
  providerLabel,
  deepLinks,
  canEdit,
}: IntegrationDetailClientProps) {
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });

  const { data: healthData } = useSWR<IntegrationsHealthResponse>(
    '/v1/health/integrations',
    fetchIntegrationsHealth,
    { refreshInterval: 60_000 },
  );

  const providerHealth = healthData?.providers.find(
    (p) => p.provider === provider,
  );
  const healthState: HealthState = providerHealth?.state ?? 'unknown';

  async function handleTest() {
    setTestState({ kind: 'loading' });
    try {
      const supabase = createSupabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';

      const res = await edgeFetch(`/v1/integrations/${provider}/test`, token, {
        method: 'POST',
        body: JSON.stringify({ source: 'config_screen' }),
      });

      const result = (await res.json()) as TestResponse;

      if (!res.ok || result.status === 'error') {
        const failedPhase = result.phases.find((p) => !p.ok);
        setTestState({
          kind: 'error',
          result,
          message:
            failedPhase != null
              ? `Falha na fase "${failedPhase.name}"`
              : 'Teste falhou — verifique as credenciais.',
        });
      } else {
        setTestState({ kind: 'success', result });
      }
    } catch {
      setTestState({
        kind: 'error',
        result: { status: 'error', phases: [] },
        message: 'Não foi possível conectar ao servidor.',
      });
    }
  }

  const fields = CREDENTIAL_FIELDS[provider] ?? [];

  return (
    <div className="space-y-4">
      {/* Health summary card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Saúde (últimas 24h)</CardTitle>
            <HealthBadge
              size="md"
              state={healthState}
              incidentCount={providerHealth?.incident_count}
            />
          </div>
        </CardHeader>
        {providerHealth?.metrics_24h != null && (
          <CardContent>
            <ul
              className="text-sm space-y-1"
              aria-label={`Métricas de ${providerLabel}`}
            >
              <li className="text-green-600">
                {providerHealth.metrics_24h.dispatched} eventos enviados
              </li>
              {providerHealth.metrics_24h.skipped > 0 && (
                <li className="text-yellow-600">
                  {providerHealth.metrics_24h.skipped} ignorados (consent negado
                  ou filtrado)
                </li>
              )}
              {providerHealth.metrics_24h.failed > 0 && (
                <li className="text-red-600">
                  {providerHealth.metrics_24h.failed} falharam
                </li>
              )}
            </ul>
          </CardContent>
        )}
      </Card>

      {/* Test event card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Testar configuração</CardTitle>
          <CardDescription>
            Dispara um evento sintético para validar credenciais sem afetar
            produção.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {testState.kind !== 'idle' && (
            <TestFlow state={testState} providerLabel={providerLabel} />
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => void handleTest()}
              disabled={testState.kind === 'loading'}
              size="sm"
            >
              {testState.kind === 'loading' && (
                <Loader2
                  className="h-4 w-4 mr-1.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              Disparar evento de teste
            </Button>
            {testState.kind !== 'idle' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTestState({ kind: 'idle' })}
              >
                Limpar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Credentials card — only visible to operators/admins */}
      {canEdit && fields.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Configuração de credenciais
            </CardTitle>
            <CardDescription>
              Credenciais armazenadas com criptografia em repouso.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {fields.map((f) => (
                <div key={f.field} className="space-y-1">
                  <label
                    htmlFor={`cred-${f.field}`}
                    className="inline-flex items-center gap-1 text-sm font-medium"
                  >
                    {f.label}
                    {f.optional && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (opcional)
                      </span>
                    )}
                    {(() => {
                      const tip = FIELD_TOOLTIPS[f.field];
                      return tip != null ? <TooltipHelp content={tip} /> : null;
                    })()}
                  </label>
                  <input
                    id={`cred-${f.field}`}
                    type={f.masked ? 'password' : 'text'}
                    readOnly={f.readOnly}
                    placeholder={
                      f.readOnly
                        ? '(configurado via painel de administração)'
                        : ''
                    }
                    className={cn(
                      'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      f.readOnly && 'opacity-60 cursor-not-allowed',
                    )}
                    aria-describedby={
                      f.readOnly ? `cred-${f.field}-hint` : undefined
                    }
                  />
                  {f.readOnly && (
                    <p
                      id={`cred-${f.field}-hint`}
                      className="text-xs text-muted-foreground"
                    >
                      Somente leitura — configure via painel de administração.
                    </p>
                  )}
                </div>
              ))}
            </div>
            <Button size="sm" disabled>
              Salvar configuração
            </Button>
            <p className="text-xs text-muted-foreground">
              Salvamento de credenciais disponível em próxima versão.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Deep links card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Links externos</CardTitle>
          <CardDescription>
            Ferramentas nativas para diagnóstico e configuração.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {deepLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Abrir ${link.label} em nova aba`}
                className={cn(
                  'inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm',
                )}
              >
                {link.label}
                <ExternalLink
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
              </a>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Progressive test flow — renders phases as a horizontal stepper
function TestFlow({
  state,
  providerLabel,
}: {
  state: Exclude<TestState, { kind: 'idle' }>;
  providerLabel: string;
}) {
  const phases: TestPhase[] =
    state.kind === 'loading'
      ? [
          { name: 'Sistema', ok: true },
          { name: providerLabel, ok: false },
          { name: 'Confirmação', ok: false },
        ]
      : state.result.phases.length > 0
        ? state.result.phases
        : [
            { name: 'Sistema', ok: state.kind === 'success' },
            { name: providerLabel, ok: state.kind === 'success' },
            { name: 'Confirmação', ok: state.kind === 'success' },
          ];

  return (
    // aria-live: announces phase changes to screen readers (WCAG 4.1.3)
    <div aria-live="polite" aria-label="Status do teste" className="space-y-3">
      <ol
        className="flex items-center gap-2 text-sm"
        aria-label="Fases do teste"
      >
        {phases.map((phase, i) => {
          const isLast = i === phases.length - 1;
          const isRunning =
            state.kind === 'loading' &&
            (i === phases.findIndex((p) => !p.ok) ||
              (phases.every((p) => p.ok) && i === phases.length - 1));

          return (
            <li key={phase.name} className="flex items-center gap-2">
              <span className="flex items-center gap-1.5">
                {state.kind === 'loading' && isRunning ? (
                  <Loader2
                    className="h-4 w-4 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : phase.ok ? (
                  <CheckCircle
                    className="h-4 w-4 text-green-600"
                    aria-hidden="true"
                  />
                ) : (
                  <XCircle
                    className="h-4 w-4 text-red-500"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={cn(
                    phase.ok && state.kind !== 'loading'
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {phase.name}
                </span>
                {phase.latency_ms != null && (
                  <span className="text-xs text-muted-foreground">
                    ({phase.latency_ms}ms)
                  </span>
                )}
              </span>
              {!isLast && (
                <span className="text-muted-foreground" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {state.kind === 'success' && (
        // Using <output> per WAI-ARIA semantic elements (lint/a11y/useSemanticElements)
        <output className="text-sm text-green-600 font-medium block">
          Tudo funcionando.
        </output>
      )}

      {state.kind === 'error' && (
        <p className="text-sm text-red-600" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
