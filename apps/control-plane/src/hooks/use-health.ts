import type { HealthState } from '@/components/health-badge';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import useSWR from 'swr';

// Shape returned by GET /v1/health/integrations
export interface IntegrationsHealthResponse {
  state: HealthState;
  summary?: string;
  checkedAt?: string;
}

async function fetchWithAuth(url: string): Promise<IntegrationsHealthResponse> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';

  const res = await edgeFetch(url, token);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  return res.json() as Promise<IntegrationsHealthResponse>;
}

/**
 * Polls GET /v1/health/integrations every 60 s (SWR).
 *
 * Fail-soft: on fetch error returns state='unknown' with tooltip copy per
 * docs/70-ux/07-component-health-badges.md §7.
 *
 * docs/70-ux/07-component-health-badges.md §3, §7
 */
export function useIntegrationsHealth() {
  const { data, error, isLoading } = useSWR<IntegrationsHealthResponse>(
    '/v1/health/integrations',
    fetchWithAuth,
    {
      refreshInterval: 60_000,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 3) return;
        setTimeout(() => revalidate({ retryCount }), 5_000);
      },
    },
  );

  if (isLoading) {
    return { state: 'loading' as HealthState, summary: undefined };
  }

  if (error != null || data == null) {
    // Fail-soft: never crash the sidebar on health fetch failure
    return {
      state: 'unknown' as HealthState,
      summary: 'Não foi possível verificar saúde',
    };
  }

  return {
    state: data.state,
    summary: data.summary,
  };
}
