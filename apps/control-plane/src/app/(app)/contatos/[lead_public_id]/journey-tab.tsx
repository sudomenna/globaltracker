'use client';

/**
 * journey-tab.tsx — aba "Jornada" da página de detalhe de lead.
 *
 * Onda 4 (Sprint 17): T-17-012.
 *
 * Visão completa cronológica DESC dos eventos do lead, agrupando dispatches
 * e tags correlacionados em <EventCard> e intercalando <StageDivider> quando
 * há mudança de stage. Reusa o endpoint /v1/leads/:id/timeline (mesmo do
 * lead-timeline-client). A duplicação de fetch é temporária — Onda 5 vai
 * extrair `useTimeline()` hook compartilhado.
 *
 * BR-IDENTITY-013: usa lead_public_id, nunca lead_id interno.
 * BR-PRIVACY-001 + BR-RBAC: PII gating delegado ao backend e ao EventCard.
 */

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { useCallback } from 'react';
import useSWR from 'swr';
import { EventCard, type OrderBumpSummary, type TimelineNode } from './event-card';
import { StageDivider } from './journey-helpers';

interface TimelineResponse {
  lead_public_id: string;
  nodes: TimelineNode[];
  next_cursor: string | null;
  total_count: number;
}

interface JourneyTabProps {
  leadPublicId: string;
  role: string;
}

const CORRELATION_WINDOW_MS = 30_000;

type EventItem = { kind: 'event'; key: string; event: TimelineNode; dispatches: TimelineNode[]; tags: TimelineNode[]; stageChange: TimelineNode | null };
type StageItem = { kind: 'stage'; key: string; node: TimelineNode };

// GroupedItem: saída de groupNodes — só event + stage, sem purchase_group
type GroupedItem = EventItem | StageItem;

// TimelineItem: saída final após mergePurchaseGroups — inclui purchase_group
type TimelineItem =
  | GroupedItem
  | { kind: 'purchase_group'; key: string; primary: EventItem; orderBumps: EventItem[] };

/**
 * Agrupa nodes em blocos de evento + intercala stage dividers.
 *
 * Heurística (sem campos compartilhados garantidos entre tabelas):
 *   - Ordena tudo por occurred_at ASC.
 *   - Para cada `event_captured`, anexa todos os `dispatch_*` cujo
 *     occurred_at está dentro de [event.ts, event.ts + 30s] OU cujo
 *     payload.event_id === event.id (quando disponível).
 *   - `tag_added`: anexa quando payload.source_event_name === event.payload.event_name
 *     E timestamp dentro da janela.
 *   - `stage_changed`: vira StageDivider entre eventos quando ocorre
 *     entre dois `event_captured` consecutivos.
 *   - Demais tipos (attribution_set, consent_updated, merge) ficam fora desta
 *     aba (visão "Jornada" prioriza eventos + dispatches; abas dedicadas em
 *     Onda 5 cobrem o resto).
 *
 * Saída final: ordem DESC (mais recente em cima).
 */
function groupNodes(nodes: TimelineNode[]): GroupedItem[] {
  const sortedAsc = [...nodes].sort(
    (a, b) =>
      new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  );

  const events = sortedAsc.filter((n) => n.type === 'event_captured');
  const dispatches = sortedAsc.filter((n) => n.type.startsWith('dispatch_'));
  const tags = sortedAsc.filter((n) => n.type === 'tag_added');
  const stages = sortedAsc.filter((n) => n.type === 'stage_changed');

  // Track consumed dispatches/tags to evitar dupla-atribuição
  const consumedDispatches = new Set<string>();
  const consumedTags = new Set<string>();

  const items: GroupedItem[] = [];

  events.forEach((event, idx) => {
    const eventTs = new Date(event.occurred_at).getTime();
    const nextEvent = events[idx + 1];
    const nextEventTs = nextEvent
      ? new Date(nextEvent.occurred_at).getTime()
      : Number.POSITIVE_INFINITY;

    // Dispatches: dentro da janela OU event_id bate
    const matchedDispatches = dispatches.filter((d) => {
      if (consumedDispatches.has(d.id)) return false;
      const dTs = new Date(d.occurred_at).getTime();
      const payloadEventId = d.payload?.event_id;
      if (payloadEventId && payloadEventId === event.id) return true;
      // janela: entre eventTs e min(eventTs + 30s, nextEventTs)
      const windowEnd = Math.min(eventTs + CORRELATION_WINDOW_MS, nextEventTs);
      return dTs >= eventTs && dTs <= windowEnd;
    });
    matchedDispatches.forEach((d) => consumedDispatches.add(d.id));

    // Tags: source_event_name bate + timestamp dentro da janela
    const matchedTags = tags.filter((t) => {
      if (consumedTags.has(t.id)) return false;
      const tTs = new Date(t.occurred_at).getTime();
      const sourceEventName = t.payload?.source_event_name;
      const eventName = event.payload?.event_name;
      const inWindow =
        tTs >= eventTs &&
        tTs <= Math.min(eventTs + CORRELATION_WINDOW_MS, nextEventTs);
      return sourceEventName === eventName && inWindow;
    });
    matchedTags.forEach((t) => consumedTags.add(t.id));

    // stage_changed correlacionado: source_event_id bate
    const stageChange =
      stages.find((s) => s.payload?.source_event_id === event.id) ?? null;

    items.push({
      kind: 'event',
      key: `event-${event.id}`,
      event,
      dispatches: matchedDispatches,
      tags: matchedTags,
      stageChange,
    });
  });

  // Stage dividers: stages que NÃO foram correlacionados a nenhum evento
  // (mudança "solta" — ex: webhook puro, system-driven). Insere como divider
  // posicional entre eventos.
  const correlatedStageIds = new Set(
    items
      .filter((i): i is Extract<TimelineItem, { kind: 'event' }> => i.kind === 'event')
      .map((i) => i.stageChange?.id)
      .filter((id): id is string => !!id),
  );
  const looseStages = stages.filter((s) => !correlatedStageIds.has(s.id));
  for (const s of looseStages) {
    items.push({ kind: 'stage', key: `stage-${s.id}`, node: s });
  }

  // Re-sort ASC pelo timestamp do item (event.occurred_at ou stage.occurred_at)
  items.sort((a, b) => {
    const ta =
      a.kind === 'event'
        ? new Date(a.event.occurred_at).getTime()
        : new Date(a.node.occurred_at).getTime();
    const tb =
      b.kind === 'event'
        ? new Date(b.event.occurred_at).getTime()
        : new Date(b.node.occurred_at).getTime();
    return ta - tb;
  });

  // Inverter para DESC (mais recente em cima) — DoD T-17-012
  return items.reverse();
}

/**
 * Agrupa eventos Purchase ou InitiateCheckout do OnProfit que compartilham o
 * mesmo transaction_group_id + event_name. Apenas webhook:onprofit com
 * transaction_group_id não-nulo são elegíveis — Guru e demais sources ficam
 * intocados.
 *
 * Group key = `${transaction_group_id}:${event_name}` — separa Purchase e
 * InitiateCheckout mesmo quando coincidem no mesmo bucket de 5min.
 */
const GROUPABLE_EVENT_NAMES = new Set(['Purchase', 'InitiateCheckout']);

function mergePurchaseGroups(items: GroupedItem[]): TimelineItem[] {
  const grouped = new Map<string, EventItem[]>();

  for (const item of items) {
    if (item.kind !== 'event') continue;
    const cd = item.event.payload.custom_data as Record<string, unknown> | undefined;
    const tgId = cd?.transaction_group_id as string | undefined;
    const source = item.event.payload.event_source as string | undefined;
    const name = item.event.payload.event_name as string | undefined;
    if (tgId && source === 'webhook:onprofit' && name && GROUPABLE_EVENT_NAMES.has(name)) {
      const groupKey = `${tgId}:${name}`;
      const bucket = grouped.get(groupKey) ?? [];
      bucket.push(item);
      grouped.set(groupKey, bucket);
    }
  }

  // Apenas grupos com >1 evento precisam de merge
  const toMerge = new Map<string, EventItem[]>();
  for (const [id, bucket] of grouped) {
    if (bucket.length > 1) toMerge.set(id, bucket);
  }
  if (toMerge.size === 0) return items;

  const mergedIds = new Set<string>();
  for (const bucket of toMerge.values()) {
    for (const it of bucket) mergedIds.add(it.key);
  }

  const result: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === 'stage' || !mergedIds.has(item.key)) {
      result.push(item);
      continue;
    }
    const cd = item.event.payload.custom_data as Record<string, unknown> | undefined;
    const tgId = cd?.transaction_group_id as string;
    const name = item.event.payload.event_name as string;
    const groupKey = `${tgId}:${name}`;
    // Só insere o grupo na primeira ocorrência (primary = item_type 'product')
    if (!result.some((r) => r.kind === 'purchase_group' && r.key === `pg-${groupKey}`)) {
      const bucket = toMerge.get(groupKey)!;
      const primary = (bucket.find((it) => {
        const c = it.event.payload.custom_data as Record<string, unknown> | undefined;
        return (c?.item_type as string | undefined) !== 'order_bump';
      }) ?? bucket[0]) as EventItem;
      const orderBumps = bucket.filter((it) => it.key !== primary.key);
      result.push({ kind: 'purchase_group', key: `pg-${groupKey}`, primary, orderBumps });
    }
  }
  return result;
}

export function JourneyTab({ leadPublicId, role }: JourneyTabProps) {
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

  // Busca TODOS os tipos sem filtros — visão "Jornada" é a completa.
  const url = `/v1/leads/${encodeURIComponent(leadPublicId)}/timeline?limit=50`;

  const { data, error, isLoading, mutate } = useSWR<TimelineResponse>(
    url,
    fetcher,
  );

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Carregando jornada">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
          <div key={i} className="rounded-lg border p-4 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-sm text-muted-foreground">
          Não foi possível carregar a jornada.
        </p>
        <Button variant="outline" size="sm" onClick={() => void mutate()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const nodes = data?.nodes ?? [];
  if (nodes.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground">
          Esse lead ainda não tem atividade registrada.
        </p>
      </div>
    );
  }

  const items = mergePurchaseGroups(groupNodes(nodes));

  return (
    <div className="space-y-0">
      {items.map((item) => {
        if (item.kind === 'stage') {
          const stageName = String(item.node.payload.stage ?? '?');
          return (
            <StageDivider
              key={item.key}
              stage={stageName}
              timestamp={item.node.occurred_at}
            />
          );
        }

        if (item.kind === 'purchase_group') {
          const obSummaries: OrderBumpSummary[] = item.orderBumps.map((ob) => {
            const cd = ob.event.payload.custom_data as Record<string, unknown> | undefined;
            return {
              key: ob.key,
              productName: (cd?.product_name as string | undefined) ?? 'Order Bump',
              amount: cd?.amount as number | undefined,
              currency: (cd?.currency as string | undefined) ?? 'BRL',
            };
          });
          return (
            <EventCard
              key={item.key}
              event={item.primary.event}
              dispatches={item.primary.dispatches}
              tags={item.primary.tags}
              stageChange={item.primary.stageChange}
              role={role}
              orderBumps={obSummaries}
            />
          );
        }

        return (
          <EventCard
            key={item.key}
            event={item.event}
            dispatches={item.dispatches}
            tags={item.tags}
            stageChange={item.stageChange}
            role={role}
          />
        );
      })}
    </div>
  );
}
