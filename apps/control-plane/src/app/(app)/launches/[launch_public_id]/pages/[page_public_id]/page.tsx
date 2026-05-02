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

  // Initial status fetch — Server Component pre-populates data to avoid
  // a client-side loading flash on first render.
  let initialStatus: PageStatus | null = null;
  try {
    const res = await fetch(`${baseUrl}/v1/pages/${page_public_id}/status`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      // Do not cache — status changes frequently
      cache: 'no-store',
    });
    if (res.ok) {
      initialStatus = (await res.json()) as PageStatus;
    }
  } catch {
    // Client will handle retries via SWR polling
  }

  return (
    <PageDetailClient
      launchPublicId={launch_public_id}
      pagePublicId={page_public_id}
      accessToken={session.access_token}
      initialStatus={initialStatus}
    />
  );
}
