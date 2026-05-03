'use client';

import type { OnboardingState } from '@/app/(app)/onboarding/types';
import { HealthBadge } from '@/components/health-badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  type WorkspaceIncident,
  useWorkspaceHealth,
} from '@/hooks/use-workspace-health';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import useSWR from 'swr';

// Shape returned by GET /v1/onboarding/state
interface OnboardingStateResponse {
  onboarding_state: OnboardingState;
}

async function fetchOnboardingState(
  url: string,
): Promise<OnboardingStateResponse> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';

  const res = await edgeFetch(url, token);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return res.json() as Promise<OnboardingStateResponse>;
}

function useOnboardingState() {
  const { data } = useSWR<OnboardingStateResponse>(
    '/v1/onboarding/state',
    fetchOnboardingState,
    { refreshInterval: 60_000 },
  );

  const state = data?.onboarding_state;
  // Banner only shown when onboarding exists but is neither completed nor skipped
  const showIncompleteBanner =
    state != null && state.completed_at == null && state.skipped_at == null;

  return { showIncompleteBanner };
}

function IncidentItem({ incident }: { incident: WorkspaceIncident }) {
  const providerPath = `/integrations/${incident.provider}`;
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
      <p className="text-sm font-medium capitalize">{incident.provider}</p>
      <p className="text-xs text-muted-foreground">{incident.message}</p>
      <Link
        href={providerPath}
        className="text-xs text-primary hover:underline self-start"
      >
        Investigar →
      </Link>
    </li>
  );
}

function IncidentsPanel({
  open,
  onClose,
  incidents,
}: {
  open: boolean;
  onClose: () => void;
  incidents: WorkspaceIncident[];
}) {
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent aria-label="Saúde do Workspace">
        <SheetHeader onClose={onClose}>
          <SheetTitle>Saúde do Workspace</SheetTitle>
        </SheetHeader>
        <SheetBody>
          {incidents.length === 0 ? (
            // aria-live so screen readers announce when incidents resolve
            <p
              className="text-sm text-muted-foreground text-center py-6"
              aria-live="polite"
            >
              Tudo funcionando ✓
            </p>
          ) : (
            <ul
              className="divide-y"
              aria-live="polite"
              aria-label={`${incidents.length} incidentes ativos`}
            >
              {incidents.map((inc, i) => (
                // provider+type combination is unique within a workspace response
                <IncidentItem
                  key={`${inc.provider}-${inc.type}-${i}`}
                  incident={inc}
                />
              ))}
            </ul>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

export function AppHeader({ workspaceName }: { workspaceName: string | null }) {
  const [panelOpen, setPanelOpen] = React.useState(false);
  const { state, incidents, incidentCount } = useWorkspaceHealth();
  const { showIncompleteBanner } = useOnboardingState();

  return (
    <>
      {/* Setup incomplete banner — full-width above header */}
      {showIncompleteBanner && (
        <div
          role="alert"
          className="flex items-center justify-between bg-yellow-50 border-b border-yellow-200 px-6 py-2 text-sm text-yellow-800"
        >
          <span>Complete seu setup para ativar o rastreamento.</span>
          <Link
            href="/onboarding"
            className="font-medium underline hover:no-underline ml-4"
          >
            Continuar setup →
          </Link>
        </div>
      )}

      <header className="flex h-16 items-center gap-4 border-b bg-card px-6">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">
            {workspaceName ?? 'Workspace'}
          </span>
          {/* docs/70-ux/07-component-health-badges.md §5 — B.4 workspace header badge */}
          <HealthBadge
            state={state}
            size="sm"
            incidentCount={incidentCount}
            tooltip={
              incidentCount > 0
                ? `${incidentCount} incidente${incidentCount > 1 ? 's' : ''} ativo${incidentCount > 1 ? 's' : ''}`
                : 'Tudo funcionando'
            }
            onClick={() => setPanelOpen(true)}
            aria-label={
              incidentCount > 0
                ? `Saúde do workspace — ${incidentCount} incidente${incidentCount > 1 ? 's' : ''} ativo${incidentCount > 1 ? 's' : ''}. Abrir painel.`
                : 'Saúde do workspace — Saudável. Abrir painel.'
            }
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Trocar workspace"
            disabled
          >
            Trocar workspace
          </Button>

          <Button variant="ghost" size="icon" aria-label="Notificações">
            <Bell className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* Lazy-rendered via conditional mount — only in DOM when open */}
      <IncidentsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        incidents={incidents}
      />
    </>
  );
}
