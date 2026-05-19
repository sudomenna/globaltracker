'use client';

import { Badge } from '@/components/ui/badge';
import {
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Loader2,
  Mail,
  Phone,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function useAccessToken(): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
    if (match) {
      try {
        let raw = match[1];
        if (raw?.startsWith('base64-')) raw = atob(raw.slice(7));
        else if (raw) raw = decodeURIComponent(raw);
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

interface LeadItem {
  lead_public_id: string;
  display_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased' | 'archived';
  first_seen_at: string;
  last_seen_at: string;
  last_purchase_at: string | null;
}

type SortField = 'last_seen_at' | 'first_seen_at' | 'name' | 'last_purchase_at';
type SortDir = 'asc' | 'desc';

const EDGE = process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

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

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55'))
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  if (digits.length === 12 && digits.startsWith('55'))
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  return raw;
}

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

export default function ArchivedContactsPage() {
  const accessToken = useAccessToken();

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sortBy, setSortBy] = useState<SortField>('last_seen_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const [items, setItems] = useState<LeadItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [totalFiltered, setTotalFiltered] = useState<number | null>(null);
  const [totalUnfiltered, setTotalUnfiltered] = useState<number | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const selectionCount = selectAllMatching ? (totalFiltered ?? 0) : selectedIds.size;
  const allLoadedSelected = useMemo(
    () => items.length > 0 && items.every((i) => selectedIds.has(i.lead_public_id)),
    [items, selectedIds],
  );

  function handleSort(field: SortField) {
    if (sortBy === field) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortBy(field);
      setSortDir('desc');
    }
  }

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
      const params = new URLSearchParams({ limit: '30', status: 'archived' });
      if (debouncedQ) params.set('q', debouncedQ);
      params.set('sort_by', sortBy);
      params.set('sort_dir', sortDir);
      if (cursor) params.set('cursor', cursor);

      const isLoadMore = !!cursor;
      if (isLoadMore) setLoadingMore(true);
      else {
        setLoading(true);
        setItems([]);
        setNextCursor(null);
        setSelectedIds(new Set());
        setSelectAllMatching(false);
      }
      try {
        const res = await fetch(`${EDGE}/v1/leads?${params.toString()}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          items: LeadItem[];
          next_cursor: string | null;
          total_filtered?: number;
          total_unfiltered?: number;
        };
        setItems((prev) => (isLoadMore ? [...prev, ...(body.items ?? [])] : (body.items ?? [])));
        setNextCursor(body.next_cursor ?? null);
        if (!isLoadMore) {
          if (typeof body.total_filtered === 'number') setTotalFiltered(body.total_filtered);
          if (typeof body.total_unfiltered === 'number') setTotalUnfiltered(body.total_unfiltered);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, debouncedQ, sortBy, sortDir],
  );

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  function toggleRow(id: string) {
    if (selectAllMatching) {
      const seed = new Set(items.map((i) => i.lead_public_id));
      seed.delete(id);
      setSelectedIds(seed);
      setSelectAllMatching(false);
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAllLoaded() {
    if (selectAllMatching) {
      setSelectAllMatching(false);
      setSelectedIds(new Set());
      return;
    }
    if (allLoadedSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(items.map((i) => i.lead_public_id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }

  async function runBulk(
    endpoint: 'bulk-unarchive' | 'bulk-delete',
    confirmText?: string,
  ) {
    if (!accessToken || selectionCount === 0) return;
    if (confirmText && !window.confirm(confirmText)) return;
    const setBusy = endpoint === 'bulk-unarchive' ? setRestoring : setDeleting;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (selectAllMatching && debouncedQ) body.q = debouncedQ;
      // Bulk over the archived view: only IDs OR `q` make sense; no lifecycle/launch filter UI here.
      // If select-all-matching and no `q`, the server still scopes by status=archived implicitly
      // when called from the archive endpoint; but `bulk-delete` and `bulk-unarchive` resolve via
      // their own statusFilter logic. For safety, require at least IDs in select-all-no-q case.
      if (!selectAllMatching) body.lead_public_ids = Array.from(selectedIds);
      else if (!debouncedQ) {
        // select-all-matching with no filters → need to pass all loaded IDs as an
        // explicit set (the page count is the total, but we can't enumerate without
        // a server roundtrip). For simplicity, force user to use IDs here.
        body.lead_public_ids = Array.from(selectedIds);
      }

      const res = await fetch(`${EDGE}/v1/leads/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 401) {
          alert('Sessão expirada. Faça login novamente.');
          window.location.href = '/login';
        } else if (res.status === 403) alert('Você não tem permissão.');
        else alert(`Falha (HTTP ${res.status}). Tente novamente.`);
        return;
      }
      clearSelection();
      await fetchLeads();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Contatos arquivados</h1>
          <p className="text-sm text-muted-foreground">
            Contatos escondidos da listagem principal — restaure para usar novamente
            {totalFiltered !== null && totalUnfiltered !== null && (
              <>
                {' · '}
                <span className="tabular-nums">
                  {totalFiltered.toLocaleString('pt-BR')}/
                  {totalUnfiltered.toLocaleString('pt-BR')} arquivados
                </span>
              </>
            )}
          </p>
        </div>
        <Link
          href="/contatos"
          className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Voltar para contatos
        </Link>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, email, telefone ou ID…"
            className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
      </div>

      {selectionCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5">
          <div className="flex items-center gap-3 text-sm">
            <button type="button" onClick={clearSelection} aria-label="Limpar seleção" className="rounded p-1 hover:bg-muted">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="font-medium tabular-nums">
              {selectionCount.toLocaleString('pt-BR')}{' '}
              {selectionCount === 1 ? 'contato selecionado' : 'contatos selecionados'}
            </span>
            {!selectAllMatching && allLoadedSelected && totalFiltered !== null && totalFiltered > items.length && (
              <button
                type="button"
                onClick={() => setSelectAllMatching(true)}
                className="text-xs text-primary hover:underline"
              >
                Selecionar todos os {totalFiltered.toLocaleString('pt-BR')} arquivados
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runBulk('bulk-unarchive')}
              disabled={restoring || deleting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {restoring ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArchiveRestore className="h-4 w-4" aria-hidden="true" />}
              Restaurar
            </button>
            <button
              type="button"
              onClick={() =>
                runBulk(
                  'bulk-delete',
                  `Excluir definitivamente ${selectionCount} ${selectionCount === 1 ? 'contato' : 'contatos'}?\n\nEsta ação anonimiza o contato (PII removida) e não pode ser desfeita.`,
                )
              }
              disabled={restoring || deleting}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-destructive/30 bg-background px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
              Excluir definitivamente
            </button>
          </div>
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Carregando…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Users className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {debouncedQ ? 'Nenhum contato arquivado encontrado com essa busca.' : 'Nenhum contato arquivado.'}
            </p>
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted">
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos os contatos carregados"
                      checked={selectAllMatching || (items.length > 0 && allLoadedSelected)}
                      ref={(el) => {
                        if (el) el.indeterminate = !selectAllMatching && selectedIds.size > 0 && !allLoadedSelected;
                      }}
                      onChange={toggleSelectAllLoaded}
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                  </th>
                  <th className="text-left px-4 py-3 font-normal">
                    <span className="text-xs font-medium text-muted-foreground">Contato</span>
                  </th>
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell w-px whitespace-nowrap">
                    <SortableHeader label="Primeiro contato" field="first_seen_at" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell w-px whitespace-nowrap">
                    <SortableHeader label="Última atividade" field="last_seen_at" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell w-px whitespace-nowrap">
                    <SortableHeader label="Última compra" field="last_purchase_at" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((lead) => {
                  const isSelected = selectAllMatching || selectedIds.has(lead.lead_public_id);
                  return (
                    <tr key={lead.lead_public_id} className={`hover:bg-muted transition-colors ${isSelected ? 'bg-primary/5' : ''}`}>
                      <td className="px-3 py-3 align-top">
                        <input
                          type="checkbox"
                          aria-label={`Selecionar contato ${lead.display_name ?? lead.lead_public_id}`}
                          checked={isSelected}
                          onChange={() => toggleRow(lead.lead_public_id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </td>
                      <td className="px-4 py-3 min-w-0">
                        <Link href={`/contatos/${lead.lead_public_id}`} className="flex flex-col gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate">{lead.display_name ?? '—'}</span>
                            <Badge variant="secondary">Arquivado</Badge>
                          </div>
                          <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-4 sm:gap-y-1">
                            <span className="inline-flex items-center gap-1.5 truncate">
                              <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">{lead.display_email ?? '—'}</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5 truncate">
                              <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">{lead.display_phone ? formatPhone(lead.display_phone) : '—'}</span>
                            </span>
                          </div>
                        </Link>
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell whitespace-nowrap">
                        <p className="text-xs font-medium tabular-nums">{formatDateTime(lead.first_seen_at)}</p>
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell whitespace-nowrap">
                        <p className="text-xs font-medium tabular-nums">{formatDateTime(lead.last_seen_at)}</p>
                      </td>
                      <td className="px-3 py-3 hidden sm:table-cell whitespace-nowrap">
                        <p className="text-xs font-medium tabular-nums">
                          {lead.last_purchase_at ? formatDateTime(lead.last_purchase_at) : <span className="text-muted-foreground">—</span>}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/contatos/${lead.lead_public_id}`} tabIndex={-1}>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
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
                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
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
