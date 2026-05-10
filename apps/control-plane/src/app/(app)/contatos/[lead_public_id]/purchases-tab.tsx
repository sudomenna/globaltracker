'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { edgeFetch } from '@/lib/api-client';
import { Package, ShoppingBag } from 'lucide-react';
import { useEffect, useState } from 'react';

interface PurchaseItem {
  event_id: string;
  item_type: 'product' | 'order_bump' | string | null;
  amount: number;
  product_name: string | null;
  order_id: string | null;
  occurred_at: string;
}

interface PurchaseGroup {
  transaction_group_id: string | null;
  total_amount: number;
  currency: string;
  occurred_at: string;
  item_count: number;
  items: PurchaseItem[];
}

interface PurchasesResponse {
  purchase_groups: PurchaseGroup[];
}

interface PurchasesTabProps {
  leadPublicId: string;
  accessToken: string;
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency || 'BRL',
  }).format(amount);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ItemTypeIcon({ itemType }: { itemType: string | null }) {
  if (itemType === 'product') {
    return <ShoppingBag className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />;
  }
  return <Package className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />;
}

function ItemTypeBadge({ itemType }: { itemType: string | null }) {
  if (itemType === 'product') {
    return <Badge variant="default">produto</Badge>;
  }
  if (itemType === 'order_bump') {
    return <Badge variant="secondary">order bump</Badge>;
  }
  if (itemType) {
    return <Badge variant="outline">{itemType}</Badge>;
  }
  return null;
}

function PurchaseGroupCard({ group }: { group: PurchaseGroup }) {
  const groupRef = group.transaction_group_id
    ? group.transaction_group_id.slice(-8)
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-0.5">
            <p className="text-sm text-muted-foreground">{formatDate(group.occurred_at)}</p>
            {groupRef && (
              <p className="text-xs font-mono text-muted-foreground">
                grupo: …{groupRef}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold tabular-nums">
              {formatCurrency(group.total_amount, group.currency)}
            </p>
            <p className="text-xs text-muted-foreground">
              {group.item_count === 1
                ? '1 item'
                : `${group.item_count} itens`}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {group.items.map((item) => (
            <li
              key={item.event_id}
              className="flex items-center gap-2 rounded-md border px-3 py-2"
            >
              <ItemTypeIcon itemType={item.item_type} />
              <span className="flex-1 text-sm truncate">
                {item.product_name ?? (
                  <span className="text-muted-foreground italic">sem nome</span>
                )}
              </span>
              <ItemTypeBadge itemType={item.item_type} />
              <span className="text-sm font-medium tabular-nums shrink-0">
                {formatCurrency(item.amount, group.currency)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function PurchasesTab({ leadPublicId, accessToken }: PurchasesTabProps) {
  const [data, setData] = useState<PurchasesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(false);
      try {
        const res = await edgeFetch(
          `/v1/leads/${encodeURIComponent(leadPublicId)}/purchases`,
          accessToken,
        );
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const json = (await res.json()) as PurchasesResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [leadPublicId, accessToken]);

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground">
          Não foi possível carregar as compras.
        </p>
      </div>
    );
  }

  if (!data || data.purchase_groups.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground">
          Nenhuma compra registrada para este contato.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.purchase_groups.map((group) => (
        <PurchaseGroupCard
          key={group.transaction_group_id ?? group.items[0]?.event_id}
          group={group}
        />
      ))}
    </div>
  );
}
