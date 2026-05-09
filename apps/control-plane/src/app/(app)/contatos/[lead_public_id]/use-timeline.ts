'use client';

/**
 * use-timeline.ts — shared SWR-Infinite hook for timeline endpoint.
 *
 * BR-IDENTITY-013: callers identify leads by `lead_public_id` only.
 * Extracted from `lead-timeline-client.tsx` (T-17-015) so multiple tabs
 * (Eventos, Despachos, Atribuição, Consentimento) can reuse the same fetch +
 * filter machinery without duplicating SWR keys.
 */

import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { useCallback } from 'react';
import useSWRInfinite from 'swr/infinite';

export type NodeType =
  | 'event_captured'
  | 'dispatch_queued'
  | 'dispatch_success'
  | 'dispatch_failed'
  | 'dispatch_skipped'
  | 'attribution_set'
  | 'stage_changed'
  | 'merge'
  | 'consent_updated'
  | 'tag_added';

export type NodeStatus = 'ok' | 'failed' | 'skipped' | 'pending';

export interface TimelineNode {
  id: string;
  type: NodeType;
  occurred_at: string;
  status: NodeStatus;
  payload: Record<string, unknown>;
  skip_reason: string | null;
  can_replay: boolean;
  // Optional convenience fields exposed by the edge (T-17-001/002).
  label?: string;
  detail?: string;
  destination?: string;
  job_id?: string;
}

export interface TimelineResponse {
  nodes: TimelineNode[];
  next_cursor: string | null;
}

export const ALL_NODE_TYPES: NodeType[] = [
  'event_captured',
  'dispatch_queued',
  'dispatch_success',
  'dispatch_failed',
  'dispatch_skipped',
  'attribution_set',
  'stage_changed',
  'merge',
  'consent_updated',
  'tag_added',
];

export const PERIOD_PRESETS = [
  { label: 'Tudo', value: 'all' },
  { label: 'Últimas 24h', value: '24h' },
  { label: '7 dias', value: '7d' },
  { label: '30 dias', value: '30d' },
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number]['value'];

export function buildTimelineUrl(
  leadPublicId: string,
  cursor: string | null,
  typeFilter: NodeType[],
  statusFilter: NodeStatus | 'all',
  period: PeriodPreset,
): string {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (cursor) params.set('cursor', cursor);
  const filtersPayload: { types?: NodeType[]; statuses?: NodeStatus[] } = {};
  if (typeFilter.length > 0 && typeFilter.length < ALL_NODE_TYPES.length) {
    filtersPayload.types = typeFilter;
  }
  if (statusFilter !== 'all') {
    filtersPayload.statuses = [statusFilter];
  }
  if (Object.keys(filtersPayload).length > 0) {
    params.set('filters', JSON.stringify(filtersPayload));
  }
  if (period !== 'all') {
    const now = new Date();
    if (period === '24h') {
      params.set('since', new Date(now.getTime() - 86400000).toISOString());
    } else if (period === '7d') {
      params.set('since', new Date(now.getTime() - 7 * 86400000).toISOString());
    } else if (period === '30d') {
      params.set(
        'since',
        new Date(now.getTime() - 30 * 86400000).toISOString(),
      );
    }
  }
  return `/v1/leads/${encodeURIComponent(leadPublicId)}/timeline?${params.toString()}`;
}

export interface UseTimelineOpts {
  leadPublicId: string;
  typeFilter: NodeType[];
  statusFilter: NodeStatus | 'all';
  period: PeriodPreset;
}

export function useTimeline(opts: UseTimelineOpts) {
  const { leadPublicId, typeFilter, statusFilter, period } = opts;

  const getKey = useCallback(
    (pageIndex: number, previousData: TimelineResponse | null) => {
      if (previousData && !previousData.next_cursor) return null;
      const cursor =
        pageIndex === 0 ? null : (previousData?.next_cursor ?? null);
      return buildTimelineUrl(
        leadPublicId,
        cursor,
        typeFilter,
        statusFilter,
        period,
      );
    },
    [leadPublicId, typeFilter, statusFilter, period],
  );

  const fetcher = useCallback(
    async (url: string): Promise<TimelineResponse> => {
      const supabase = createSupabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token ?? '';
      const res = await edgeFetch(url, token);
      if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
      return res.json() as Promise<TimelineResponse>;
    },
    [],
  );

  const swr = useSWRInfinite<TimelineResponse>(getKey, fetcher);

  const allNodes = swr.data?.flatMap((page) => page.nodes) ?? [];
  const lastPage = swr.data?.[swr.data.length - 1];
  const hasMore = !!lastPage?.next_cursor;

  return {
    data: swr.data,
    error: swr.error,
    isLoading: swr.isLoading,
    isValidating: swr.isValidating,
    size: swr.size,
    setSize: swr.setSize,
    mutate: swr.mutate,
    allNodes,
    hasMore,
  };
}
