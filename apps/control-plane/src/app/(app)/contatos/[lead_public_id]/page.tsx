import { type Lifecycle, LifecycleBadge } from '@/components/lifecycle-badge';
import { Badge } from '@/components/ui/badge';
import { TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseServer } from '@/lib/supabase-server';
import { Mail, Phone } from 'lucide-react';
import { redirect } from 'next/navigation';
import { AttributionTab } from './attribution-tab';
import { ConsentTab } from './consent-tab';
import { DispatchesTab } from './dispatches-tab';
import { EventsTab } from './events-tab';
import { PurchasesTab } from './purchases-tab';
import { IdentityTab } from './identity-tab';
import { JourneyTab } from './journey-tab';
import type {
  NodeStatus,
  NodeType,
  PeriodPreset,
} from './events-tab';
import { LeadSummaryHeader } from './lead-summary-header';
import type { LeadSummary as LeadSummaryAggregate } from './lead-summary-types';
import { RevealPiiButton } from './reveal-pii-button';
import { TabsWithUrlSync } from './tabs-with-url-sync';

// BR-IDENTITY-013: lead_public_id é o identificador externo seguro; nunca expor lead_id interno

interface LeadIdentity {
  lead_public_id: string;
  display_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased';
  lifecycle_status?: Lifecycle;
  created_at?: string;
  role?: string;
  pii_masked?: boolean;
}

const STATUS_BADGE: Record<
  LeadIdentity['status'],
  'default' | 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'
> = {
  active: 'success',
  merged: 'secondary',
  erased: 'outline',
};

const STATUS_LABEL: Record<LeadIdentity['status'], string> = {
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

// T-17-011: deep-link de aba ativa
const TAB_VALUES = [
  'jornada',
  'eventos',
  'compras',
  'despachos',
  'atribuicao',
  'consent',
  'identidade',
] as const;
type TabValue = (typeof TAB_VALUES)[number];
const DEFAULT_TAB: TabValue = 'jornada';

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

  // T-17-009: fetch paralelo de identidade + summary agregado.
  // identidade -> /v1/leads/:id (PII com masking server-side por role)
  // summary    -> /v1/leads/:id/summary (PII-free; stages, tags, atribuição, consent, métricas)
  const [identityResult, summaryResult] = await Promise.allSettled([
    edgeFetch(`/v1/leads/${encodeURIComponent(lead_public_id)}`, accessToken),
    edgeFetch(
      `/v1/leads/${encodeURIComponent(lead_public_id)}/summary`,
      accessToken,
    ),
  ]);

  let lead: LeadIdentity | null = null;
  if (identityResult.status === 'fulfilled' && identityResult.value.ok) {
    try {
      lead = (await identityResult.value.json()) as LeadIdentity;
    } catch {
      lead = null;
    }
  }

  let summary: LeadSummaryAggregate | null = null;
  if (summaryResult.status === 'fulfilled' && summaryResult.value.ok) {
    try {
      summary = (await summaryResult.value.json()) as LeadSummaryAggregate;
    } catch {
      summary = null;
    }
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

  // T-17-011: aba ativa via ?tab=... (default: jornada).
  const rawTab = typeof sp.tab === 'string' ? sp.tab : undefined;
  const initialTab: TabValue =
    rawTab && (TAB_VALUES as readonly string[]).includes(rawTab)
      ? (rawTab as TabValue)
      : DEFAULT_TAB;

  const displayName = maskDisplayName(lead?.display_name ?? null, role);
  const leadStatus = lead?.status ?? 'active';
  const piiMasked = lead?.pii_masked === true;
  const canReveal = role !== 'viewer' && piiMasked;
  const edgeUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  // BR-RBAC: aba "Identidade" só renderiza para roles diferentes de marketer.
  const showIdentityTab = role !== 'marketer';

  return (
    <div className="space-y-6">
      {/* Header de identificação */}
      <div className="space-y-1">
        <nav className="text-xs text-muted-foreground" aria-label="Localização">
          <span>Contatos</span>
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
          {lead?.lifecycle_status && (
            <LifecycleBadge lifecycle={lead.lifecycle_status} />
          )}
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
          Este contato foi anonimizado por SAR — dados removidos
        </output>
      )}

      {/* T-17-010: Header agregado (PII-free). Só renderiza se summary chegou. */}
      {summary && <LeadSummaryHeader summary={summary} role={role} />}

      {/* T-17-009/011: Tabs com deep-link via ?tab= */}
      <TabsWithUrlSync
        defaultValue={initialTab}
        validValues={TAB_VALUES}
        className="w-full"
      >
        <TabsList>
          <TabsTrigger value="jornada">Jornada</TabsTrigger>
          <TabsTrigger value="eventos">Eventos</TabsTrigger>
          <TabsTrigger value="compras">Compras</TabsTrigger>
          <TabsTrigger value="despachos">Despachos</TabsTrigger>
          <TabsTrigger value="atribuicao">Atribuição</TabsTrigger>
          <TabsTrigger value="consent">Consent</TabsTrigger>
          {showIdentityTab && (
            <TabsTrigger value="identidade">Identidade</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="jornada">
          <JourneyTab leadPublicId={lead_public_id} role={role} />
        </TabsContent>

        <TabsContent value="eventos">
          <EventsTab
            leadPublicId={lead_public_id}
            role={role}
            initialTypeFilter={initialTypeFilter}
            initialStatusFilter={initialStatusFilter}
            initialPeriod={initialPeriod}
          />
        </TabsContent>

        <TabsContent value="compras">
          <PurchasesTab leadPublicId={lead_public_id} accessToken={accessToken} />
        </TabsContent>

        <TabsContent value="despachos">
          <DispatchesTab leadPublicId={lead_public_id} role={role} />
        </TabsContent>

        <TabsContent value="atribuicao">
          <AttributionTab leadPublicId={lead_public_id} />
        </TabsContent>

        <TabsContent value="consent">
          <ConsentTab leadPublicId={lead_public_id} />
        </TabsContent>

        {showIdentityTab && (
          <TabsContent value="identidade">
            <IdentityTab leadPublicId={lead_public_id} role={role} />
          </TabsContent>
        )}
      </TabsWithUrlSync>
    </div>
  );
}
