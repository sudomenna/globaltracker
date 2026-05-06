'use client';

import { Badge } from '@/components/ui/badge';
import { ChevronRight, Loader2, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Auth hook ────────────────────────────────────────────────────────────────

function useAccessToken(): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        let raw = match[1];
        if (raw?.startsWith('base64-')) {
          raw = atob(raw.slice(7));
        } else if (raw) {
          raw = decodeURIComponent(raw);
        }
        if (raw) {
          const parsed = JSON.parse(raw) as { access_token?: string };
          setToken(parsed?.access_token ?? '');
        }
      } catch {
        setToken('');
      }
    }
  }, []);
  return token;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeadItem {
  lead_public_id: string;
  display_name: string | null;
  status: 'active' | 'merged' | 'erased';
  first_seen_at: string;
  last_seen_at: string;
}

interface Launch {
  name: string;
  public_id: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EDGE = process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

const STATUS_BADGE: Record<
  LeadItem['status'],
  'default' | 'success' | 'secondary' | 'outline'
> = {
  active: 'success',
  merged: 'secondary',
  erased: 'outline',
};

const STATUS_LABEL: Record<LeadItem['status'], string> = {
  active: 'Ativo',
  merged: 'Unificado',
  erased: 'Anonimizado',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const accessToken = useAccessToken();

  const [launches, setLaunches] = useState<Launch[]>([]);
  const [selectedLaunch, setSelectedLaunch] = useState('');

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [items, setItems] = useState<LeadItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Load launches for filter dropdown
  useEffect(() => {
    if (!accessToken) return;
    fetch(`${EDGE}/v1/launches`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((r) => r.json())
      .then((body: { launches?: Launch[] }) => {
        setLaunches(body.launches ?? []);
      })
      .catch(() => {});
  }, [accessToken]);

  // Debounce search input
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQ(q), 400);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [q]);

  const fetchLeads = useCallback(
    async (cursor?: string) => {
      if (!accessToken) return;

      const params = new URLSearchParams({ limit: '30' });
      if (debouncedQ) params.set('q', debouncedQ);
      if (selectedLaunch) params.set('launch_public_id', selectedLaunch);
      if (cursor) params.set('cursor', cursor);

      const isLoadMore = !!cursor;
      if (isLoadMore) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setItems([]);
        setNextCursor(null);
      }

      try {
        const res = await fetch(`${EDGE}/v1/leads?${params.toString()}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          items: LeadItem[];
          next_cursor: string | null;
        };
        setItems((prev) =>
          isLoadMore ? [...prev, ...(body.items ?? [])] : (body.items ?? []),
        );
        setNextCursor(body.next_cursor ?? null);
      } catch {
        // silent
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, debouncedQ, selectedLaunch],
  );

  // Re-fetch when filters or search change
  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Busque e analise seus leads
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por ID do lead…"
            className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        {launches.length > 0 && (
          <select
            value={selectedLaunch}
            onChange={(e) => setSelectedLaunch(e.target.value)}
            className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-w-xs"
          >
            <option value="">Todos os lançamentos</option>
            {launches.map((l) => (
              <option key={l.public_id} value={l.public_id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Results */}
      <div className="rounded-md border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Carregando…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Users
              className="h-8 w-8 text-muted-foreground/50"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {debouncedQ || selectedLaunch
                ? 'Nenhum lead encontrado com esses filtros.'
                : 'Nenhum lead registrado ainda.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y">
              {items.map((lead) => (
                <li key={lead.lead_public_id}>
                  <Link
                    href={`/leads/${lead.lead_public_id}`}
                    className="flex items-center justify-between py-3 px-4 hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">
                          {lead.display_name ?? '—'}
                        </span>
                        <Badge variant={STATUS_BADGE[lead.status]}>
                          {STATUS_LABEL[lead.status]}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                        {lead.lead_public_id}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 ml-4 shrink-0">
                      <div className="text-right hidden sm:block">
                        <p className="text-xs text-muted-foreground">
                          Última atividade
                        </p>
                        <p className="text-xs font-medium">
                          {formatDate(lead.last_seen_at)}
                        </p>
                      </div>
                      <ChevronRight
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            {nextCursor && (
              <div className="flex justify-center py-4 border-t">
                <button
                  type="button"
                  onClick={() => void fetchLeads(nextCursor)}
                  disabled={loadingMore}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Carregar mais
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
