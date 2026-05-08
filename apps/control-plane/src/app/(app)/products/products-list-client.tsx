'use client';

import { Badge } from '@/components/ui/badge';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { Loader2, Package, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type ProductCategory =
  | 'ebook'
  | 'workshop_online'
  | 'webinar'
  | 'curso_online'
  | 'curso_presencial'
  | 'pos_graduacao'
  | 'treinamento_online'
  | 'evento_fisico'
  | 'mentoria_individual'
  | 'mentoria_grupo'
  | 'acompanhamento_individual';

interface Product {
  id: string;
  name: string;
  category: ProductCategory | null;
  external_provider: string;
  external_product_id: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  purchase_count: number;
  affected_leads: number;
}

interface ProductsResponse {
  items: Product[];
  next_cursor: string | null;
}

interface PatchResponse {
  leads_recalculated?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<ProductCategory, string> = {
  ebook: 'Ebook',
  workshop_online: 'Workshop online',
  webinar: 'Webinar',
  curso_online: 'Curso online',
  curso_presencial: 'Curso presencial',
  pos_graduacao: 'Pós-graduação',
  treinamento_online: 'Treinamento online',
  evento_fisico: 'Evento físico',
  mentoria_individual: 'Mentoria individual',
  mentoria_grupo: 'Mentoria em grupo',
  acompanhamento_individual: 'Acompanhamento individual',
};

const CATEGORY_OPTIONS: ProductCategory[] = [
  'ebook',
  'workshop_online',
  'webinar',
  'curso_online',
  'curso_presencial',
  'pos_graduacao',
  'treinamento_online',
  'evento_fisico',
  'mentoria_individual',
  'mentoria_grupo',
  'acompanhamento_individual',
];

const STATUS_LABEL: Record<Product['status'], string> = {
  active: 'Ativo',
  archived: 'Arquivado',
};

const STATUS_VARIANT: Record<
  Product['status'],
  'success' | 'secondary' | 'outline'
> = {
  active: 'success',
  archived: 'secondary',
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

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

// ─── Toast (minimal inline) ───────────────────────────────────────────────────

interface ToastMsg {
  id: number;
  message: string;
  kind: 'success' | 'error';
}

interface ProductsListClientProps {
  canEdit: boolean;
}

export function ProductsListClient({ canEdit }: ProductsListClientProps) {
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('active');

  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastIdRef = useRef(0);

  // Add modal state
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createProvider, setCreateProvider] = useState<string>('guru');
  const [createExtId, setCreateExtId] = useState('');
  const [createCategory, setCreateCategory] = useState<ProductCategory | ''>('');
  const [createError, setCreateError] = useState<string | null>(null);

  function pushToast(message: string, kind: 'success' | 'error' = 'success') {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }

  // Debounce search input
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQ(q), 400);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [q]);

  const fetchProducts = useCallback(
    async (cursor?: string) => {
      const accessToken = await getAccessToken();
      if (!accessToken) return;

      const params = new URLSearchParams({ limit: '30' });
      if (debouncedQ) params.set('q', debouncedQ);
      if (categoryFilter) params.set('category', categoryFilter);
      if (statusFilter) params.set('status', statusFilter);
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
        const res = await edgeFetch(
          `/v1/products?${params.toString()}`,
          accessToken,
        );
        if (!res.ok) return;
        const body = (await res.json()) as ProductsResponse;
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
    [debouncedQ, categoryFilter, statusFilter],
  );

  useEffect(() => {
    void fetchProducts();
  }, [fetchProducts]);

  async function handleExternalIdSave(productId: string, newId: string) {
    const trimmed = newId.trim();
    if (!trimmed) return;

    const previous = items.find((p) => p.id === productId);
    if (!previous || previous.external_product_id === trimmed) return;

    const accessToken = await getAccessToken();
    if (!accessToken) return;

    // Optimistic
    setItems((prev) =>
      prev.map((p) =>
        p.id === productId ? { ...p, external_product_id: trimmed } : p,
      ),
    );

    try {
      const res = await edgeFetch(
        `/v1/products/${encodeURIComponent(productId)}`,
        accessToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ external_product_id: trimmed }),
        },
      );
      if (!res.ok) {
        // rollback
        setItems((prev) =>
          prev.map((p) =>
            p.id === productId
              ? { ...p, external_product_id: previous.external_product_id }
              : p,
          ),
        );
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          code?: string;
        };
        pushToast(
          body.code === 'conflict'
            ? 'Já existe outro produto com este ID externo.'
            : (body.message ?? 'Falha ao atualizar ID externo.'),
          'error',
        );
        return;
      }
      pushToast('ID externo atualizado.');
    } catch {
      setItems((prev) =>
        prev.map((p) =>
          p.id === productId
            ? { ...p, external_product_id: previous.external_product_id }
            : p,
        ),
      );
      pushToast('Falha ao atualizar ID externo.', 'error');
    }
  }

  async function handleCreate() {
    setCreateError(null);
    const name = createName.trim();
    const extId = createExtId.trim();
    if (!name) {
      setCreateError('Nome é obrigatório.');
      return;
    }
    if (!extId) {
      setCreateError('ID externo é obrigatório.');
      return;
    }

    const accessToken = await getAccessToken();
    if (!accessToken) return;

    setCreating(true);
    try {
      const res = await edgeFetch('/v1/products', accessToken, {
        method: 'POST',
        body: JSON.stringify({
          name,
          external_provider: createProvider,
          external_product_id: extId,
          category: createCategory === '' ? null : createCategory,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          code?: string;
        };
        if (body.code === 'conflict') {
          setCreateError(
            body.message ?? 'Já existe um produto com este ID externo.',
          );
        } else {
          setCreateError(body.message ?? 'Falha ao criar produto.');
        }
        return;
      }
      // Reset form, close modal, refetch
      setAddOpen(false);
      setCreateName('');
      setCreateProvider('guru');
      setCreateExtId('');
      setCreateCategory('');
      pushToast('Produto cadastrado.');
      await fetchProducts();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Erro desconhecido.');
    } finally {
      setCreating(false);
    }
  }

  async function handleNameSave(productId: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) return;

    const previous = items.find((p) => p.id === productId);
    if (!previous || previous.name === trimmed) return;

    const accessToken = await getAccessToken();
    if (!accessToken) return;

    // Optimistic update
    setItems((prev) =>
      prev.map((p) => (p.id === productId ? { ...p, name: trimmed } : p)),
    );

    try {
      const res = await edgeFetch(
        `/v1/products/${encodeURIComponent(productId)}`,
        accessToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (!res.ok) {
        setItems((prev) =>
          prev.map((p) =>
            p.id === productId ? { ...p, name: previous.name } : p,
          ),
        );
        pushToast('Falha ao atualizar nome.', 'error');
        return;
      }
      pushToast('Nome atualizado.');
    } catch {
      setItems((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, name: previous.name } : p,
        ),
      );
      pushToast('Falha ao atualizar nome.', 'error');
    }
  }

  async function handleCategoryChange(
    productId: string,
    newCategory: ProductCategory | '',
  ) {
    const accessToken = await getAccessToken();
    if (!accessToken) return;

    const previous = items.find((p) => p.id === productId);
    if (!previous) return;

    const optimistic = newCategory === '' ? null : newCategory;

    // Optimistic update
    setItems((prev) =>
      prev.map((p) =>
        p.id === productId ? { ...p, category: optimistic } : p,
      ),
    );

    try {
      const res = await edgeFetch(
        `/v1/products/${encodeURIComponent(productId)}`,
        accessToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ category: optimistic }),
        },
      );
      if (!res.ok) {
        // rollback
        setItems((prev) =>
          prev.map((p) =>
            p.id === productId ? { ...p, category: previous.category } : p,
          ),
        );
        pushToast('Falha ao atualizar categoria.', 'error');
        return;
      }
      const body = (await res.json()) as PatchResponse;
      const recalculated = body.leads_recalculated ?? 0;
      pushToast(
        `Categoria atualizada. ${recalculated} lead${recalculated === 1 ? '' : 's'} recalculado${recalculated === 1 ? '' : 's'}.`,
      );
    } catch {
      setItems((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, category: previous.category } : p,
        ),
      );
      pushToast('Falha ao atualizar categoria.', 'error');
    }
  }

  return (
    <div className="space-y-4">
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
            placeholder="Buscar por nome…"
            className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filtrar por categoria"
          className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-w-xs"
        >
          <option value="">Todas as categorias</option>
          <option value="uncategorized">Não categorizadas</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filtrar por status"
          className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 max-w-xs"
        >
          <option value="">Todos os status</option>
          <option value="active">Ativos</option>
          <option value="archived">Arquivados</option>
        </select>

        {canEdit && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 h-10 rounded-md bg-primary text-primary-foreground px-3 text-sm font-medium hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Adicionar produto
          </button>
        )}
      </div>

      {/* Count */}
      {!loading && items.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {items.length} produto{items.length === 1 ? '' : 's'}
          {nextCursor ? ' (mais disponíveis)' : ''}
        </p>
      )}

      {/* Results */}
      <div className="rounded-md border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Carregando…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 px-4 text-center">
            <Package
              className="h-8 w-8 text-muted-foreground/50"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground max-w-md">
              {debouncedQ || categoryFilter || statusFilter !== 'active'
                ? 'Nenhum produto encontrado com esses filtros.'
                : 'Nenhum produto cadastrado ainda. Produtos são criados automaticamente quando uma compra chega via webhook.'}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30">
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Nome</th>
                    <th className="px-4 py-2 font-medium">Categoria</th>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="px-4 py-2 font-medium text-right">
                      Compras
                    </th>
                    <th className="px-4 py-2 font-medium text-right">Leads</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Atualizado em</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((p) => (
                    <tr key={p.id} className="hover:bg-accent/30">
                      <td className="px-4 py-2.5 font-medium align-middle">
                        {canEdit ? (
                          <EditableName
                            value={p.name}
                            onSave={(name) => void handleNameSave(p.id, name)}
                          />
                        ) : (
                          <div className="max-w-xs truncate" title={p.name}>
                            {p.name}
                          </div>
                        )}
                        {canEdit ? (
                          <EditableExternalId
                            value={p.external_product_id}
                            onSave={(id) =>
                              void handleExternalIdSave(p.id, id)
                            }
                          />
                        ) : (
                          <div
                            className="text-[10px] text-muted-foreground font-mono truncate max-w-xs"
                            title={p.external_product_id}
                          >
                            {p.external_product_id}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-middle">
                        {canEdit ? (
                          <select
                            value={p.category ?? ''}
                            onChange={(e) =>
                              void handleCategoryChange(
                                p.id,
                                e.target.value as ProductCategory | '',
                              )
                            }
                            aria-label={`Categoria de ${p.name}`}
                            className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            <option value="">— Não categorizado —</option>
                            {CATEGORY_OPTIONS.map((c) => (
                              <option key={c} value={c}>
                                {CATEGORY_LABEL[c]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {p.category ? CATEGORY_LABEL[p.category] : '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-middle text-xs text-muted-foreground">
                        {p.external_provider}
                      </td>
                      <td className="px-4 py-2.5 align-middle text-right tabular-nums">
                        {p.purchase_count}
                      </td>
                      <td className="px-4 py-2.5 align-middle text-right tabular-nums">
                        {p.affected_leads}
                      </td>
                      <td className="px-4 py-2.5 align-middle">
                        <Badge variant={STATUS_VARIANT[p.status]}>
                          {STATUS_LABEL[p.status]}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 align-middle text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(p.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {nextCursor && (
              <div className="flex justify-center py-4 border-t">
                <button
                  type="button"
                  onClick={() => void fetchProducts(nextCursor)}
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

      {/* Add product modal */}
      {addOpen && (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-labelledby="add-product-title"
          aria-modal="true"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => !creating && setAddOpen(false)}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg w-full max-w-md p-6 space-y-4 relative">
              <h2 id="add-product-title" className="text-base font-semibold">
                Adicionar produto
              </h2>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="prod-name" className="text-sm font-medium">
                    Nome
                  </label>
                  <input
                    id="prod-name"
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Ex: Curso Contratos Societários"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    disabled={creating}
                    maxLength={256}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label
                      htmlFor="prod-provider"
                      className="text-sm font-medium"
                    >
                      Provider
                    </label>
                    <select
                      id="prod-provider"
                      value={createProvider}
                      onChange={(e) => setCreateProvider(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      disabled={creating}
                    >
                      <option value="guru">Guru</option>
                      <option value="hotmart">Hotmart</option>
                      <option value="kiwify">Kiwify</option>
                      <option value="stripe">Stripe</option>
                      <option value="manual">Manual</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="prod-extid"
                      className="text-sm font-medium"
                    >
                      ID externo
                    </label>
                    <input
                      id="prod-extid"
                      type="text"
                      value={createExtId}
                      onChange={(e) => setCreateExtId(e.target.value)}
                      placeholder="1747647500"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                      disabled={creating}
                      maxLength={256}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label htmlFor="prod-cat" className="text-sm font-medium">
                    Categoria{' '}
                    <span className="text-muted-foreground font-normal">
                      (opcional)
                    </span>
                  </label>
                  <select
                    id="prod-cat"
                    value={createCategory}
                    onChange={(e) =>
                      setCreateCategory(e.target.value as ProductCategory | '')
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    disabled={creating}
                  >
                    <option value="">— Não categorizado —</option>
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </div>

                {createError && (
                  <p className="text-sm text-destructive" role="alert">
                    {createError}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                    setCreateError(null);
                  }}
                  disabled={creating}
                  className="inline-flex items-center h-9 rounded-md px-3 text-sm hover:bg-accent disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 h-9 rounded-md bg-primary text-primary-foreground px-3 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {creating && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  Criar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast container */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <output
              key={t.id}
              className={`rounded-md border px-4 py-2 text-sm shadow-md ${
                t.kind === 'success'
                  ? 'bg-green-50 border-green-200 text-green-800'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {t.message}
            </output>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline editable name input. Click → input. Enter or blur → save. Esc → cancel.
function EditableName({
  value,
  onSave,
}: {
  value: string;
  onSave: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // focus + select after enter edit mode
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Clique para editar"
        className="block text-left max-w-xs truncate hover:underline decoration-dotted underline-offset-2 cursor-text"
      >
        {value}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      maxLength={256}
      className="w-full max-w-xs h-7 rounded border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

// Inline editable external_product_id (Guru/Hotmart/Stripe ID). Same UX as EditableName.
function EditableExternalId({
  value,
  onSave,
}: {
  value: string;
  onSave: (newId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Clique para editar o ID externo"
        className="block text-left text-[10px] text-muted-foreground font-mono truncate max-w-xs hover:underline decoration-dotted underline-offset-2 cursor-text"
      >
        {value}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      maxLength={256}
      className="w-full max-w-xs h-6 rounded border border-input bg-background px-1.5 py-0.5 text-[10px] font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
