import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { PageDetailClient } from './page-detail-client';

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

interface PageDetail {
  url: string | null;
  allowed_domains: string[];
}

interface Props {
  params: Promise<{ launch_public_id: string; page_public_id: string }>;
}

export default async function PageDetailPage({ params }: Props) {
  const { launch_public_id, page_public_id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect('/login');
  }

  const baseUrl = process.env.EDGE_WORKER_URL ?? 'http://localhost:8787';

  const [initialStatus, initialPageDetail] = await Promise.all([
    fetch(`${baseUrl}/v1/pages/${page_public_id}/status`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
    })
      .then((r) => r.ok ? r.json() as Promise<PageStatus> : null)
      .catch((): null => null),

    fetch(
      `${baseUrl}/v1/pages?launch_public_id=${launch_public_id}`,
      { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' },
    )
      .then((r) => r.ok ? r.json() as Promise<{ pages: Array<{ public_id: string; url: string | null; allowed_domains: string[] }> }> : null)
      .then((d): PageDetail | null => {
        const found = d?.pages.find((p) => p.public_id === page_public_id);
        return found ? { url: found.url, allowed_domains: found.allowed_domains } : null;
      })
      .catch((): null => null),
  ]);

  return (
    <PageDetailClient
      launchPublicId={launch_public_id}
      pagePublicId={page_public_id}
      accessToken={session.access_token}
      initialStatus={initialStatus}
      initialUrl={initialPageDetail?.url ?? null}
      initialAllowedDomains={initialPageDetail?.allowed_domains ?? []}
    />
  );
}
