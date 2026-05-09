'use client';

/**
 * attribution-tab.tsx — Sprint 17 / T-17-017
 *
 * Lists every attribution_set timeline node for the lead. Renders each
 * touchpoint with UTM tuple, click ids and ad/campaign/link ids. Sorted
 * descending by `occurred_at` (most recent first), matching the timeline
 * default.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type NodeType,
  type TimelineNode,
  useTimeline,
} from './use-timeline';

interface AttributionTabProps {
  leadPublicId: string;
}

const ATTRIBUTION_TYPES: NodeType[] = ['attribution_set'];

function pickString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function TouchTypeBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const variant: 'success' | 'secondary' | 'outline' =
    value === 'first' ? 'success' : value === 'last' ? 'secondary' : 'outline';
  const label =
    value === 'first'
      ? 'first-touch'
      : value === 'last'
        ? 'last-touch'
        : value;
  return <Badge variant={variant}>{label}</Badge>;
}

function MonoPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground truncate max-w-[160px] align-middle">
      {children}
    </span>
  );
}

function Cell({ value }: { value: string | null }) {
  return (
    <td className="px-3 py-2 text-sm">
      {value ? value : <span className="text-muted-foreground">—</span>}
    </td>
  );
}

function PillsCell({ items }: { items: Array<[string, string | null]> }) {
  const present = items.filter(([, v]) => !!v);
  if (present.length === 0)
    return (
      <td className="px-3 py-2 text-sm">
        <span className="text-muted-foreground">—</span>
      </td>
    );
  return (
    <td className="px-3 py-2 text-sm">
      <div className="flex flex-wrap gap-1">
        {present.map(([k, v]) => (
          <MonoPill key={k}>
            <span className="text-muted-foreground/70">{k}:</span> {v}
          </MonoPill>
        ))}
      </div>
    </td>
  );
}

function AttributionRow({ node }: { node: TimelineNode }) {
  const p = node.payload;
  const touchType = pickString(p, 'touch_type');
  const utmSource = pickString(p, 'utm_source');
  const utmMedium = pickString(p, 'utm_medium');
  const utmCampaign = pickString(p, 'utm_campaign');
  const utmContent = pickString(p, 'utm_content');
  const utmTerm = pickString(p, 'utm_term');
  const fbclid = pickString(p, 'fbclid');
  const gclid = pickString(p, 'gclid');
  const adId = pickString(p, 'ad_id');
  const campaignId = pickString(p, 'campaign_id');
  const adAccountId = pickString(p, 'ad_account_id');
  const linkId = pickString(p, 'link_id');
  const ts = new Date(node.occurred_at).toLocaleString('pt-BR');

  return (
    <tr className="border-b">
      <td className="px-3 py-2">
        <TouchTypeBadge value={touchType} />
      </td>
      <Cell value={utmSource} />
      <Cell value={utmMedium} />
      <Cell value={utmCampaign} />
      <Cell value={utmContent} />
      <Cell value={utmTerm} />
      <PillsCell
        items={[
          ['fbclid', fbclid],
          ['gclid', gclid],
        ]}
      />
      <PillsCell
        items={[
          ['ad_account', adAccountId],
          ['campaign', campaignId],
          ['ad', adId],
        ]}
      />
      <Cell value={linkId} />
      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
        {ts}
      </td>
    </tr>
  );
}

export function AttributionTab({ leadPublicId }: AttributionTabProps) {
  const {
    error,
    isLoading,
    isValidating,
    size,
    setSize,
    mutate,
    allNodes,
    hasMore,
  } = useTimeline({
    leadPublicId,
    typeFilter: ATTRIBUTION_TYPES,
    statusFilter: 'all',
    period: 'all',
  });

  // Default sort cronológico DESC — useTimeline já entrega ordenado pela API.
  const nodes = allNodes;

  return (
    <div className="space-y-4">
      {isLoading && (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && error && (
        <div className="text-center py-12 space-y-3">
          <p className="text-sm text-muted-foreground">
            Não foi possível carregar a atribuição.
          </p>
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            Tentar novamente
          </Button>
        </div>
      )}

      {!isLoading && !error && nodes.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">
            Sem touchpoints registrados.
          </p>
        </div>
      )}

      {!isLoading && !error && nodes.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-muted/40">
              <tr className="border-b">
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Touch
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Source
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Medium
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Campaign
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Content
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Term
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Click IDs
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Ad IDs
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Link
                </th>
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Quando
                </th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <AttributionRow key={node.id} node={node} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <Button
          variant="outline"
          className="w-full mt-2"
          onClick={() => void setSize(size + 1)}
          disabled={isValidating}
        >
          {isValidating ? 'Carregando...' : 'Carregar mais antigos'}
        </Button>
      )}
    </div>
  );
}
