import type { HealthState } from '@/components/health-badge';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import useSWR from 'swr';

export interface WorkspaceIncident {
  provider: string;
  type: string;
  message: string;
  since: string;
}

export interface WorkspaceHealthResponse {
  state: HealthState;
  integrations: { state: HealthState; incident_count: number };
  pages: { state: HealthState; incident_count: number };
  incidents: WorkspaceIncident[];
}

async function fetchWorkspaceHealth(
  url: string,
): Promise<WorkspaceHealthResponse> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';

  const res = await edgeFetch(url, token);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return res.json() as Promise<WorkspaceHealthResponse>;
}

/**
 * Polls GET /v1/health/workspace every 60 s (SWR).
 *
 * Fail-soft: on fetch error returns state='unknown' with empty incidents per
 * docs/70-ux/07-component-health-badges.md §7.
 */
export function useWorkspaceHealth() {
  const { data, error, isLoading } = useSWR<WorkspaceHealthResponse>(
    '/v1/health/workspace',
    fetchWorkspaceHealth,
    {
      refreshInterval: 60_000,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return;
        setTimeout(() => revalidate({ retryCount }), 5_000);
      },
    },
  );

  if (isLoading) {
    return {
      state: 'loading' as HealthState,
      incidents: [] as WorkspaceIncident[],
      incidentCount: 0,
    };
  }

  if (error != null || data == null) {
    // Fail-soft: never crash the header on health fetch failure
    return {
      state: 'unknown' as HealthState,
      incidents: [] as WorkspaceIncident[],
      incidentCount: 0,
    };
  }

  return {
    state: data.state,
    incidents: data.incidents,
    incidentCount: data.incidents.length,
  };
}
