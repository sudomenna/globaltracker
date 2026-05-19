'use client';

import { type Lifecycle, LifecycleBadge } from '@/components/lifecycle-badge';
import { Badge } from '@/components/ui/badge';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Download,
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
  status: 'active' | 'merged' | 'erased' | 'archived';
  lifecycle_status?: Lifecycle;
  first_seen_at: string;
  last_seen_at: string;
  last_purchase_at: string | null;
}

type SortField = 'last_seen_at' | 'first_seen_at' | 'name' | 'lifecycle_status' | 'last_purchase_at';
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
  archived: 'secondary',
};

const STATUS_LABEL: Record<LeadItem['status'], string> = {
  active: 'Ativo',
  merged: 'Unificado',
  erased: 'Anonimizado',
  archived: 'Arquivado',
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

  const [totalFiltered, setTotalFiltered] = useState<number | null>(null);
  const [totalUnfiltered, setTotalUnfiltered] = useState<number | null>(null);

  // Selection state. `selectAllMatching` = "select every row matching current
  // filters" — wins over `selectedIds` (which is the per-row selection set
  // built from the currently loaded items).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const selectionCount = selectAllMatching
    ? (totalFiltered ?? 0)
    : selectedIds.size;

  const allLoadedSelected = useMemo(
    () => items.length > 0 && items.every((i) => selectedIds.has(i.lead_public_id)),
    [items, selectedIds],
  );

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
        // Filters changed → drop selection. (load-more keeps it.)
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
        setItems((prev) =>
          isLoadMore ? [...prev, ...(body.items ?? [])] : (body.items ?? []),
        );
        setNextCursor(body.next_cursor ?? null);
        if (!isLoadMore) {
          if (typeof body.total_filtered === 'number') setTotalFiltered(body.total_filtered);
          if (typeof body.total_unfiltered === 'number') setTotalUnfiltered(body.total_unfiltered);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, debouncedQ, selectedLaunch, selectedLifecycle, sortBy, sortDir],
  );

  function toggleRow(id: string) {
    if (selectAllMatching) {
      // Leaving select-all-matching mode → seed selection with everything
      // currently loaded MINUS the one being toggled off.
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
    if (allLoadedSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.lead_public_id)));
    }
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }

  async function exportCsv() {
    if (!accessToken || selectionCount === 0) return;
    setExporting(true);
    try {
      const body: Record<string, unknown> = {};
      if (selectAllMatching) {
        if (debouncedQ) body.q = debouncedQ;
        if (selectedLaunch) body.launch_public_id = selectedLaunch;
        if (selectedLifecycle) body.lifecycle = selectedLifecycle;
      } else {
        body.lead_public_ids = Array.from(selectedIds);
      }

      // Two-step download: POST authenticates and prepares a short-lived
      // download URL; navigation triggers a real browser download so the
      // file lands in Downloads with the proper filename (no `a.download`
      // shenanigans).
      const res = await fetch(`${EDGE}/v1/leads/export`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 401) {
          alert('Sessão expirada. Faça login novamente para exportar.');
          window.location.href = '/login';
        } else {
          alert(`Falha ao exportar (HTTP ${res.status}). Tente novamente.`);
        }
        return;
      }
      const { download_url } = (await res.json()) as { download_url: string };
      window.location.assign(`${EDGE}${download_url}`);
    } finally {
      setExporting(false);
    }
  }

  async function bulkDelete() {
    if (!accessToken || selectionCount === 0) return;
    const n = selectionCount;
    const ok = window.confirm(
      `Excluir ${n.toLocaleString('pt-BR')} ${n === 1 ? 'contato' : 'contatos'}?\n\n` +
        `Esta ação anonimiza o contato (PII removida) e não pode ser desfeita.`,
    );
    if (!ok) return;

    setDeleting(true);
    try {
      const body: Record<string, unknown> = {};
      if (selectAllMatching) {
        if (debouncedQ) body.q = debouncedQ;
        if (selectedLaunch) body.launch_public_id = selectedLaunch;
        if (selectedLifecycle) body.lifecycle = selectedLifecycle;
      } else {
        body.lead_public_ids = Array.from(selectedIds);
      }

      const res = await fetch(`${EDGE}/v1/leads/bulk-delete`, {
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
        } else if (res.status === 403) {
          alert('Você não tem permissão para excluir contatos.');
        } else {
          alert(`Falha ao excluir (HTTP ${res.status}). Tente novamente.`);
        }
        return;
      }
      const result = (await res.json()) as { queued: number; skipped: number; failed: number };
      const parts = [`${result.queued} enfileirado(s) para exclusão`];
      if (result.skipped) parts.push(`${result.skipped} já anonimizado(s)`);
      if (result.failed) parts.push(`${result.failed} falhou(aram)`);
      alert(parts.join(' · ') + '.\nA lista será recarregada.');
      clearSelection();
      await fetchLeads();
    } finally {
      setDeleting(false);
    }
  }

  async function bulkArchive() {
    if (!accessToken || selectionCount === 0) return;
    setArchiving(true);
    try {
      const body: Record<string, unknown> = {};
      if (selectAllMatching) {
        if (debouncedQ) body.q = debouncedQ;
        if (selectedLaunch) body.launch_public_id = selectedLaunch;
        if (selectedLifecycle) body.lifecycle = selectedLifecycle;
      } else {
        body.lead_public_ids = Array.from(selectedIds);
      }

      const res = await fetch(`${EDGE}/v1/leads/bulk-archive`, {
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
        } else if (res.status === 403) {
          alert('Você não tem permissão para arquivar contatos.');
        } else {
          alert(`Falha ao arquivar (HTTP ${res.status}). Tente novamente.`);
        }
        return;
      }
      const result = (await res.json()) as { updated: number; skipped: number };
      const parts = [`${result.updated} arquivado(s)`];
      if (result.skipped) parts.push(`${result.skipped} ignorado(s)`);
      // Silent success — the row just disappears from the list, mirroring Gmail.
      clearSelection();
      await fetchLeads();
      // Tiny non-blocking confirmation via title bar would be nicer; alert is the
      // current minimum-viable feedback consistent with the other bulk actions.
      console.info('archive result:', parts.join(' · '));
    } finally {
      setArchiving(false);
    }
  }

  // Re-fetch when filters, search, or sort change
  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Contatos</h1>
          <p className="text-sm text-muted-foreground">
            Busque e analise seus contatos
            {totalFiltered !== null && totalUnfiltered !== null && (
              <>
                {' · '}
                <span className="tabular-nums">
                  {totalFiltered.toLocaleString('pt-BR')}/
                  {totalUnfiltered.toLocaleString('pt-BR')} contatos
                </span>
              </>
            )}
          </p>
        </div>
        <Link
          href="/contatos/arquivados"
          className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Archive className="h-4 w-4" aria-hidden="true" />
          Arquivados
        </Link>
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

      {/* Bulk action bar */}
      {selectionCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5">
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={clearSelection}
              aria-label="Limpar seleção"
              className="rounded p-1 hover:bg-muted"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="font-medium tabular-nums">
              {selectionCount.toLocaleString('pt-BR')}
              {' '}
              {selectionCount === 1 ? 'contato selecionado' : 'contatos selecionados'}
            </span>
            {/* Offer "select all matching" once the user has the whole page selected
                but there's more to fetch — Gmail/Linear-style. */}
            {!selectAllMatching &&
              allLoadedSelected &&
              totalFiltered !== null &&
              totalFiltered > items.length && (
                <button
                  type="button"
                  onClick={() => setSelectAllMatching(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Selecionar todos os {totalFiltered.toLocaleString('pt-BR')} que casam com o filtro
                </button>
              )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              disabled={exporting || deleting || archiving}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
              )}
              Exportar CSV
            </button>
            <button
              type="button"
              onClick={bulkArchive}
              disabled={exporting || deleting || archiving}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {archiving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Archive className="h-4 w-4" aria-hidden="true" />
              )}
              Arquivar
            </button>
            <button
              type="button"
              onClick={bulkDelete}
              disabled={exporting || deleting || archiving}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-destructive/30 bg-background px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              )}
              Excluir
            </button>
          </div>
        </div>
      )}

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
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos os contatos carregados"
                      checked={selectAllMatching || (items.length > 0 && allLoadedSelected)}
                      ref={(el) => {
                        if (el) {
                          el.indeterminate =
                            !selectAllMatching &&
                            selectedIds.size > 0 &&
                            !allLoadedSelected;
                        }
                      }}
                      onChange={toggleSelectAllLoaded}
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                  </th>
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
                  <th className="text-left px-3 py-3 font-normal hidden sm:table-cell w-px whitespace-nowrap">
                    <SortableHeader
                      label="Última compra"
                      field="last_purchase_at"
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((lead) => {
                  const isSelected =
                    selectAllMatching || selectedIds.has(lead.lead_public_id);
                  return (
                  <tr
                    key={lead.lead_public_id}
                    className={`hover:bg-muted transition-colors ${isSelected ? 'bg-primary/5' : ''}`}
                  >
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
                    <td className="px-3 py-3 hidden sm:table-cell whitespace-nowrap">
                      <Link href={`/contatos/${lead.lead_public_id}`} tabIndex={-1} className="block">
                        <p className="text-xs font-medium tabular-nums">
                          {lead.last_purchase_at ? formatDateTime(lead.last_purchase_at) : <span className="text-muted-foreground">—</span>}
                        </p>
                      </Link>
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
