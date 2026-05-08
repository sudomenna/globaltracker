import { Badge } from '@/components/ui/badge';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseServer } from '@/lib/supabase-server';
import { Mail, Phone } from 'lucide-react';
import { redirect } from 'next/navigation';
import { LeadTimelineClient } from './lead-timeline-client';
import type {
  NodeStatus,
  NodeType,
  PeriodPreset,
} from './lead-timeline-client';
import { RevealPiiButton } from './reveal-pii-button';

// BR-IDENTITY-013: lead_public_id é o identificador externo seguro; nunca expor lead_id interno

interface LeadSummary {
  lead_public_id: string;
  display_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased';
  created_at?: string;
  role?: string;
  pii_masked?: boolean;
}

const STATUS_BADGE: Record<
  LeadSummary['status'],
  'default' | 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'
> = {
  active: 'success',
  merged: 'secondary',
  erased: 'outline',
};

const STATUS_LABEL: Record<LeadSummary['status'], string> = {
  active: 'Ativo',
  merged: 'Unificado',
  erased: 'Anonimizado',
};

// BR-PRIVACY: mask display name for marketer role
function maskDisplayName(name: string | null, role: string): string {
  if (!name) return '—';
  if (role === 'marketer') {
    const parts = name.split(' ');
    const first = parts[0] ?? '';
    return `${first[0] ?? '*'}*** ****`;
  }
  return name;
}

interface PageProps {
  params: Promise<{ lead_public_id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const VALID_TYPES: NodeType[] = [
  'event_captured',
  'dispatch_queued',
  'dispatch_success',
  'dispatch_failed',
  'dispatch_skipped',
  'attribution_set',
  'stage_changed',
  'merge',
  'consent_updated',
];

export default async function LeadDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { lead_public_id } = await params;
  const sp = await searchParams;

  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const role = (user.app_metadata?.role as string | undefined) ?? 'marketer';

  const accessToken = session?.access_token ?? '';

  // Server-side initial fetch for lead summary
  let lead: LeadSummary | null = null;
  try {
    const res = await edgeFetch(
      `/v1/leads/${encodeURIComponent(lead_public_id)}`,
      accessToken,
    );
    if (res.ok) {
      lead = (await res.json()) as LeadSummary;
    }
  } catch {
    // lead stays null; header renders with defaults
  }

  // Parse filters from URL — applied client-side via query params for shareability
  const rawTypes = typeof sp.types === 'string' ? sp.types : undefined;
  const rawStatus = typeof sp.status === 'string' ? sp.status : 'all';
  const rawPeriod = typeof sp.period === 'string' ? sp.period : 'all';

  const initialTypeFilter: NodeType[] = rawTypes
    ? rawTypes
        .split(',')
        .filter((t): t is NodeType => (VALID_TYPES as string[]).includes(t))
    : VALID_TYPES;

  const VALID_STATUSES: Array<NodeStatus | 'all'> = [
    'ok',
    'failed',
    'skipped',
    'pending',
    'all',
  ];
  const initialStatusFilter: NodeStatus | 'all' = (
    VALID_STATUSES as string[]
  ).includes(rawStatus)
    ? (rawStatus as NodeStatus | 'all')
    : 'all';

  const VALID_PERIODS: PeriodPreset[] = ['all', '24h', '7d', '30d'];
  const initialPeriod: PeriodPreset = (VALID_PERIODS as string[]).includes(
    rawPeriod,
  )
    ? (rawPeriod as PeriodPreset)
    : 'all';

  const displayName = maskDisplayName(lead?.display_name ?? null, role);
  const leadStatus = lead?.status ?? 'active';
  const piiMasked = lead?.pii_masked === true;
  const canReveal = role !== 'viewer' && piiMasked;
  const edgeUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <nav className="text-xs text-muted-foreground" aria-label="Localização">
          <span>Leads</span>
          <span className="mx-1" aria-hidden="true">
            ›
          </span>
          <span>{lead_public_id}</span>
        </nav>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold">{displayName}</h1>
          <Badge variant={STATUS_BADGE[leadStatus]}>
            {STATUS_LABEL[leadStatus]}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground font-mono">
          {lead_public_id}
        </p>

        {/* Email + WhatsApp (mascarados quando role operator/viewer; ADR-034) */}
        {(lead?.display_email || lead?.display_phone) && (
          <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1 pt-1">
            {lead?.display_email && (
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">{lead.display_email}</span>
              </span>
            )}
            {lead?.display_phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono">{lead.display_phone}</span>
              </span>
            )}
            {canReveal && (
              <RevealPiiButton
                leadPublicId={lead_public_id}
                accessToken={accessToken}
                edgeUrl={edgeUrl}
              />
            )}
          </div>
        )}
      </div>

      {/* SAR/erased banner */}
      {leadStatus === 'erased' && (
        <output className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 block">
          Este lead foi anonimizado por SAR — dados removidos
        </output>
      )}

      {/* Timeline */}
      <LeadTimelineClient
        leadPublicId={lead_public_id}
        role={role}
        initialTypeFilter={initialTypeFilter}
        initialStatusFilter={initialStatusFilter}
        initialPeriod={initialPeriod}
      />
    </div>
  );
}
