'use client';

import { type Lifecycle, LifecycleBadge } from '@/components/lifecycle-badge';
import { Badge } from '@/components/ui/badge';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Loader2,
  Mail,
  Phone,
  Search,
  Users,
} from 'lucide-react';
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
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased';
  lifecycle_status?: Lifecycle;
  first_seen_at: string;
  last_seen_at: string;
}

type SortField = 'last_seen_at' | 'first_seen_at' | 'name' | 'lifecycle_status';
type SortDir = 'asc' | 'desc';

const LIFECYCLE_OPTIONS: Lifecycle[] = [
  'contato',
  'lead',
  'cliente',
  'aluno',
  'mentorado',
];

const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  contato: 'Contato',
  lead: 'Lead',
  cliente: 'Cliente',
  aluno: 'Aluno',
  mentorado: 'Mentorado',
};

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

// ADR-034: data + hora em America/Sao_Paulo (GMT-3) — fuso operacional padrão.
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Format phone for display: +55 11 9XXXX-YYYY (best-effort).
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  return raw;
}

// ─── Sortable header button ───────────────────────────────────────────────────

function SortableHeader({
  label,
  field,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  field: SortField;
  sortBy: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const isActive = sortBy === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
    >
      {label}
      {isActive ? (
        sortDir === 'desc' ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" />
        )
      ) : (
        <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
      )}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const accessToken = useAccessToken();

  const [launches, setLaunches] = useState<Launch[]>([]);
  const [selectedLaunch, setSelectedLaunch] = useState('');

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedLifecycle, setSelectedLifecycle] = useState<string>('');

  const [sortBy, setSortBy] = useState<SortField>('last_seen_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const [items, setItems] = useState<LeadItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  function handleSort(field: SortField) {
    if (sortBy === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortDir('desc');
    }
  }

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
      if (selectedLifecycle) params.set('lifecycle', selectedLifecycle);
      params.set('sort_by', sortBy);
      params.set('sort_dir', sortDir);
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
    [accessToken, debouncedQ, selectedLaunch, selectedLifecycle, sortBy, sortDir],
  );

  // Re-fetch when filters, search, or sort change
  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Contatos</h1>
        <p className="text-sm text-muted-foreground">
          Busque e analise seus contatos
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
            placeholder="Buscar por nome, email, telefone ou ID…"
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

        <select
          value={selectedLifecycle}
          onChange={(e) => setSelectedLifecycle(e.target.value)}
          aria-label="Filtrar por lifecycle"
          className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-w-xs"
        >
          <option value="">Todos os lifecycles</option>
          {LIFECYCLE_OPTIONS.map((l) => (
            <option key={l} value={l}>
              {LIFECYCLE_LABEL[l]}
            </option>
          ))}
        </select>
      </div>

      {/* Results */}
      <div className="rounded-md border overflow-hidden">
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
                ? 'Nenhum contato encontrado com esses filtros.'
                : 'Nenhum contato registrado ainda.'}
            </p>
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted">
                  <th className="text-left px-4 py-3 font-normal">
                    <span className="text-xs font-medium text-muted-foreground">Contato</span>
                  </th>
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell w-px whitespace-nowrap">
                    <SortableHeader
                      label="Primeiro contato"
                      field="first_seen_at"
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell w-px whitespace-nowrap">
                    <SortableHeader
                      label="Última atividade"
                      field="last_seen_at"
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((lead) => (
                  <tr key={lead.lead_public_id} className="hover:bg-muted transition-colors cursor-pointer">
                    <td className="px-4 py-3 min-w-0">
                      <Link
                        href={`/contatos/${lead.lead_public_id}`}
                        className="flex flex-col gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      >
                        {/* Linha 1: Nome + status */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium truncate">
                            {lead.display_name ?? '—'}
                          </span>
                          <Badge variant={STATUS_BADGE[lead.status]}>
                            {STATUS_LABEL[lead.status]}
                          </Badge>
                          {lead.lifecycle_status && (
                            <LifecycleBadge lifecycle={lead.lifecycle_status} />
                          )}
                        </div>

                        {/* Linha 2: Email | Telefone */}
                        <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-1">
                          <span className="inline-flex items-center gap-1.5 truncate">
                            <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{lead.display_email ?? '—'}</span>
                          </span>
                          <span className="inline-flex items-center gap-1.5 truncate">
                            <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">
                              {lead.display_phone ? formatPhone(lead.display_phone) : '—'}
                            </span>
                          </span>
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-3 hidden sm:table-cell whitespace-nowrap">
                      <Link href={`/contatos/${lead.lead_public_id}`} tabIndex={-1} className="block">
                        <p className="text-xs font-medium tabular-nums">
                          {formatDateTime(lead.first_seen_at)}
                        </p>
                      </Link>
                    </td>
                    <td className="px-3 py-3 hidden sm:table-cell whitespace-nowrap">
                      <Link href={`/contatos/${lead.lead_public_id}`} tabIndex={-1} className="block">
                        <p className="text-xs font-medium tabular-nums">
                          {formatDateTime(lead.last_seen_at)}
                        </p>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/contatos/${lead.lead_public_id}`} tabIndex={-1}>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {nextCursor && (
              <div className="flex justify-center py-4 border-t">
                <button
                  type="button"
                  onClick={() => void fetchLeads(nextCursor)}
                  disabled={loadingMore}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
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
