'use client';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import {
  Activity,
  ChevronLeft,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BlueprintPage {
  role?: string;
  suggested_public_id?: string;
  suggested_funnel_role?: string;
}

interface FunnelBlueprint {
  pages?: BlueprintPage[];
  stages?: unknown[];
  audiences?: unknown[];
  [key: string]: unknown;
}

interface Launch {
  public_id: string;
  name: string;
  status: string;
  created_at: string;
  config?: {
    type?: string;
    objective?: string;
    timeline?: {
      start_date?: string;
      end_date?: string;
    };
  };
  funnel_blueprint?: FunnelBlueprint | null;
}

interface Page {
  public_id: string;
  name: string;
  status: string;
  role?: string;
  url?: string | null;
  allowed_domains?: string[];
  created_at: string;
}

interface Event {
  public_id?: string;
  event_name: string;
  created_at: string;
  lead_id?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft: 'Rascunho',
  configuring: 'Configurando',
  live: 'Ao vivo',
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-muted-foreground bg-muted',
  configuring: 'text-amber-700 bg-amber-100',
  live: 'text-green-700 bg-green-100',
};

const ROLE_COLORS: Record<string, string> = {
  capture: 'bg-blue-100 text-blue-800',
  sales: 'bg-orange-100 text-orange-800',
  thankyou: 'bg-green-100 text-green-800',
  webinar: 'bg-purple-100 text-purple-800',
  checkout: 'bg-yellow-100 text-yellow-800',
  survey: 'bg-gray-100 text-gray-700',
};

// Launch roles tipados (T-PRODUCTS-008): assoc product↔launch via launch_products table.
const LAUNCH_ROLES = [
  { value: 'main_offer', label: 'Main Offer' },
  { value: 'main_order_bump', label: 'Main Order Bump' },
  { value: 'bait_offer', label: 'Bait Offer' },
  { value: 'bait_order_bump', label: 'Bait Order Bump' },
] as const;

type LaunchRoleValue = (typeof LAUNCH_ROLES)[number]['value'];

interface LaunchProductRow {
  id: string;
  product_id: string;
  name: string;
  category: string | null;
  external_provider: string;
  external_product_id: string;
  launch_role: LaunchRoleValue;
}

interface ProductCatalogItem {
  id: string;
  name: string;
  category: string | null;
  external_provider: string;
  external_product_id: string;
}

const VALID_TABS = [
  'overview',
  'funil',
  'pages',
  'eventos',
  'audiences',
  'performance',
] as const;
type TabValue = (typeof VALID_TABS)[number];

function isValidTab(value: string | null): value is TabValue {
  return VALID_TABS.includes(value as TabValue);
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

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

// ─── LaunchProductsPanel ──────────────────────────────────────────────────────

/**
 * T-PRODUCTS-008: Painel "Produtos do lançamento".
 * Substitui o legacy "Mapeamento Guru" que lia workspaces.config.integrations.guru.product_launch_map.
 *
 * Fontes de dados:
 *   - GET /v1/launches/:public_id/products  — produtos associados a este launch (com role)
 *   - GET /v1/products?status=active        — catálogo completo (para o picker)
 * Mutations:
 *   - PUT    /v1/launches/:public_id/products/:product_id  — assoc/upsert role
 *   - DELETE /v1/launches/:public_id/products/:product_id  — remove assoc
 *
 * BR-RBAC-001/002: workspace_id da auth context. PUT/DELETE ≥ admin (server-side).
 */
function LaunchProductsPanel({
  launchPublicId,
  accessToken,
  baseUrl,
}: {
  launchPublicId: string;
  accessToken: string;
  baseUrl: string;
}) {
  const [items, setItems] = useState<LaunchProductRow[]>([]);
  const [catalog, setCatalog] = useState<ProductCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickedProductId, setPickedProductId] = useState('');
  const [pickedRole, setPickedRole] = useState<LaunchRoleValue>('main_offer');
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const [resAssoc, resCatalog] = await Promise.all([
        fetch(`${baseUrl}/v1/launches/${encodeURIComponent(launchPublicId)}/products`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        fetch(`${baseUrl}/v1/products?status=active&limit=100`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ]);
      if (resAssoc.ok) {
        const body = (await resAssoc.json()) as { items: LaunchProductRow[] };
        setItems(body.items ?? []);
      }
      if (resCatalog.ok) {
        const body = (await resCatalog.json()) as { items: ProductCatalogItem[] };
        setCatalog(body.items ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, baseUrl, launchPublicId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function setRole(productId: string, newRole: LaunchRoleValue) {
    const previous = items.find((i) => i.product_id === productId);
    if (!previous || previous.launch_role === newRole) return;

    // Optimistic
    setItems((prev) =>
      prev.map((i) =>
        i.product_id === productId ? { ...i, launch_role: newRole } : i,
      ),
    );

    try {
      const res = await fetch(
        `${baseUrl}/v1/launches/${encodeURIComponent(launchPublicId)}/products/${encodeURIComponent(productId)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ launch_role: newRole }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Papel atualizado.');
    } catch (err) {
      setItems((prev) =>
        prev.map((i) =>
          i.product_id === productId
            ? { ...i, launch_role: previous.launch_role }
            : i,
        ),
      );
      toast.error(
        err instanceof Error ? err.message : 'Erro ao atualizar papel.',
      );
    }
  }

  async function handleAdd() {
    setFormError(null);
    if (!pickedProductId) {
      setFormError('Selecione um produto.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `${baseUrl}/v1/launches/${encodeURIComponent(launchPublicId)}/products/${encodeURIComponent(pickedProductId)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ launch_role: pickedRole }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      await reload();
      setModalOpen(false);
      setPickedProductId('');
      setPickedRole('main_offer');
      toast.success('Produto adicionado ao lançamento.');
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Erro ao adicionar produto.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(productId: string, name: string) {
    if (!window.confirm(`Remover "${name}" deste lançamento?`)) return;
    try {
      const res = await fetch(
        `${baseUrl}/v1/launches/${encodeURIComponent(launchPublicId)}/products/${encodeURIComponent(productId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems((prev) => prev.filter((i) => i.product_id !== productId));
      toast.success('Produto removido.');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Erro ao remover produto.',
      );
    }
  }

  // Catálogo filtrado pra mostrar só produtos NÃO já associados
  const associatedIds = new Set(items.map((i) => i.product_id));
  const availableProducts = catalog.filter((p) => !associatedIds.has(p.id));

  const roleLabel = (v: string) =>
    LAUNCH_ROLES.find((r) => r.value === v)?.label ?? v;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Produtos do lançamento</CardTitle>
            <CardDescription>
              Associe produtos do catálogo a este lançamento e defina o papel de cada um.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setModalOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Adicionar produto
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Carregando produtos...
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Nenhum produto associado a este lançamento.
              {catalog.length === 0 && (
                <>
                  {' '}Cadastre produtos primeiro em{' '}
                  <Link href="/products" className="underline hover:no-underline">
                    /products
                  </Link>
                  .
                </>
              )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-2 pr-4 font-medium">Produto</th>
                    <th className="text-left py-2 pr-4 font-medium">Papel</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((m) => (
                    <tr key={m.id}>
                      <td className="py-3 pr-4">
                        <div className="font-medium">{m.name}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {m.external_product_id}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <select
                          value={m.launch_role}
                          onChange={(e) =>
                            void setRole(m.product_id, e.target.value as LaunchRoleValue)
                          }
                          aria-label={`Papel de ${m.name}`}
                          className="h-8 rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {LAUNCH_ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive h-7 px-2"
                          onClick={() => void handleRemove(m.product_id, m.name)}
                          aria-label={`Remover ${m.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">Remover</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {modalOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-labelledby="lp-modal-title" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => !saving && setModalOpen(false)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg w-full max-w-sm p-6 space-y-4 relative">
              <h2 id="lp-modal-title" className="text-base font-semibold">
                Adicionar produto ao lançamento
              </h2>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="lp-product" className="text-sm font-medium">
                    Produto
                  </label>
                  <select
                    id="lp-product"
                    value={pickedProductId}
                    onChange={(e) => setPickedProductId(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving || availableProducts.length === 0}
                  >
                    <option value="">— Selecione —</option>
                    {availableProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {availableProducts.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      {catalog.length === 0
                        ? 'Nenhum produto cadastrado no catálogo. '
                        : 'Todos os produtos do catálogo já estão associados a este lançamento. '}
                      <Link href="/products" className="underline hover:no-underline">
                        Cadastre um novo produto em /products
                      </Link>
                      .
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label htmlFor="lp-role" className="text-sm font-medium">
                    Papel no lançamento
                  </label>
                  <select
                    id="lp-role"
                    value={pickedRole}
                    onChange={(e) => setPickedRole(e.target.value as LaunchRoleValue)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving}
                  >
                    {LAUNCH_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>

                {formError && (
                  <p className="text-sm text-destructive" role="alert">
                    {formError}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setModalOpen(false);
                    setPickedProductId('');
                    setPickedRole('main_offer');
                    setFormError(null);
                  }}
                  disabled={saving}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleAdd()}
                  disabled={saving || !pickedProductId}
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Salvando...
                    </>
                  ) : (
                    'Confirmar'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ─── Sub-components ───────────────────────────────────────────────────────────

function TabOverview({
  launch,
  accessToken,
  baseUrl,
}: {
  launch: Launch;
  accessToken: string;
  baseUrl: string;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Detalhes do lançamento</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {launch.config?.type && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0">Tipo</span>
              <span className="font-medium capitalize">
                {launch.config.type}
              </span>
            </div>
          )}
          {launch.config?.objective && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0">
                Objetivo
              </span>
              <span className="font-medium">{launch.config.objective}</span>
            </div>
          )}
          {launch.config?.timeline?.start_date && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0">
                Início
              </span>
              <span className="font-medium">
                {new Date(launch.config.timeline.start_date).toLocaleDateString(
                  'pt-BR',
                )}
              </span>
            </div>
          )}
          {launch.config?.timeline?.end_date && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0">Fim</span>
              <span className="font-medium">
                {new Date(launch.config.timeline.end_date).toLocaleDateString(
                  'pt-BR',
                )}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-muted-foreground w-28 shrink-0">
              Criado em
            </span>
            <span className="font-medium">
              {new Date(launch.created_at).toLocaleDateString('pt-BR')}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* T-PRODUCTS-008: Produtos do lançamento (substitui Mapeamento Guru legacy) */}
      <LaunchProductsPanel
        launchPublicId={launch.public_id}
        accessToken={accessToken}
        baseUrl={baseUrl}
      />
    </div>
  );
}

function TabPages({
  pages,
  launchPublicId,
  blueprint,
  accessToken,
  baseUrl,
  onPageDeleted,
}: {
  pages: Page[];
  launchPublicId: string;
  blueprint: FunnelBlueprint | null;
  accessToken: string;
  baseUrl: string;
  onPageDeleted: () => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<Page | null>(null);
  const [deleting, setDeleting] = useState(false);

  const funnelRoleByPublicId = new Map<string, string>();
  for (const bp of blueprint?.pages ?? []) {
    if (bp.suggested_public_id && bp.suggested_funnel_role) {
      funnelRoleByPublicId.set(bp.suggested_public_id, bp.suggested_funnel_role);
    }
  }

  async function handleDelete(p: Page) {
    setDeleting(true);
    try {
      const res = await fetch(
        `${baseUrl}/v1/pages/${encodeURIComponent(p.public_id)}?launch_public_id=${encodeURIComponent(launchPublicId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (res.ok) {
        toast.success(`Página "${p.public_id}" excluída`);
        setDeleteTarget(null);
        onPageDeleted();
      } else {
        toast.error('Erro ao excluir página');
      }
    } catch {
      toast.error('Erro ao excluir página');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Landing pages</CardTitle>
          <CardDescription>
            Páginas associadas a este lançamento
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/launches/${launchPublicId}/pages/new`}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Nova página
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {pages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <FileText
              className="h-6 w-6 text-muted-foreground/50"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              Nenhuma página cadastrada.
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {pages.map((p) => {
              const funnelRole = funnelRoleByPublicId.get(p.public_id);
              const domains = p.allowed_domains ?? [];
              return (
              <li key={p.public_id} className="group flex items-center gap-2 py-3 -mx-2 px-2 rounded-md hover:bg-accent/50 transition-colors">
                <Link
                  href={`/launches/${launchPublicId}/pages/${p.public_id}`}
                  className="flex-1 flex items-center justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium font-mono truncate">
                        {p.public_id}
                      </p>
                      {p.role && (
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${ROLE_COLORS[p.role] ?? 'bg-gray-100 text-gray-700'}`}
                        >
                          {p.role}
                        </span>
                      )}
                      {funnelRole && (
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-violet-100 text-violet-800">
                          {funnelRole}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground capitalize">
                        {p.status}
                      </span>
                    </div>
                    {(p.url || domains.length > 0) && (
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        {p.url && (
                          <span className="inline-flex items-center gap-1 truncate">
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            {p.url}
                          </span>
                        )}
                        {domains.length > 0 && (
                          <span className="truncate">
                            {domains.length === 1
                              ? domains[0]
                              : `${domains[0]} +${domains.length - 1}`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeleteTarget(p);
                  }}
                  aria-label={`Excluir página ${p.public_id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                </Button>
              </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {deleteTarget && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-white dark:bg-zinc-900 rounded-lg border p-6 shadow-lg max-w-sm w-full space-y-4 pointer-events-auto">
              <div>
                <h3 className="text-lg font-semibold">Excluir página</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Tem certeza que deseja excluir <span className="font-mono">{deleteTarget.public_id}</span>?
                  Esta ação não pode ser desfeita e revoga todos os tokens da página.
                </p>
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                >
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void handleDelete(deleteTarget)}
                  disabled={deleting}
                >
                  {deleting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
                      Excluindo...
                    </>
                  ) : (
                    'Excluir'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function TabEventos({
  launchPublicId,
  accessToken,
  baseUrl,
}: {
  launchPublicId: string;
  accessToken: string;
  baseUrl: string;
}) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const fetchEvents = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await fetch(
        `${baseUrl}/v1/events?launch_id=${encodeURIComponent(launchPublicId)}&limit=50`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      const body = (await res.json()) as { events?: Event[] };
      setEvents(body.events ?? []);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [accessToken, baseUrl, launchPublicId]);

  useEffect(() => {
    void fetchEvents();
    const interval = setInterval(() => void fetchEvents(), 10_000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Carregando eventos...
      </div>
    );
  }

  if (unavailable) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        Endpoint indisponível.
      </p>
    );
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">Nenhum evento ainda.</p>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Eventos recentes</CardTitle>
        <CardDescription>Atualizando a cada 10 segundos</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {events.map((e, idx) => (
            <li
              key={e.public_id ?? `${e.event_name}-${idx}`}
              className="flex items-center justify-between py-3"
            >
              <div>
                <p className="font-medium">{e.event_name}</p>
                {e.lead_id && (
                  <p className="text-xs text-muted-foreground font-mono">
                    {e.lead_id}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {new Date(e.created_at).toLocaleString('pt-BR')}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LaunchDetailPage() {
  const params = useParams<{ launch_public_id: string }>();
  const launchPublicId = params.launch_public_id;
  const accessToken = useAccessToken();
  const searchParams = useSearchParams();
  const router = useRouter();

  const rawTab = searchParams.get('tab');
  const activeTab: TabValue = isValidTab(rawTab) ? rawTab : 'overview';

  const [launch, setLaunch] = useState<Launch | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  const refreshPages = useCallback(async () => {
    if (!accessToken) return;
    try {
      const res = await fetch(
        `${baseUrl}/v1/pages?launch_public_id=${encodeURIComponent(launchPublicId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (res.ok) {
        const body = (await res.json()) as { pages?: Page[] };
        setPages(body.pages ?? []);
      }
    } catch {
      // silent
    }
  }, [accessToken, baseUrl, launchPublicId]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const [launchesRes, pagesRes] = await Promise.all([
          fetch(`${baseUrl}/v1/launches`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          fetch(
            `${baseUrl}/v1/pages?launch_public_id=${encodeURIComponent(launchPublicId)}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          ),
        ]);
        if (launchesRes.ok) {
          const body = (await launchesRes.json()) as { launches?: Launch[] };
          const found = (body.launches ?? []).find(
            (l) => l.public_id === launchPublicId,
          );
          if (!cancelled) setLaunch(found ?? null);
        }
        if (pagesRes.ok) {
          const body = (await pagesRes.json()) as { pages?: Page[] };
          if (!cancelled) setPages(body.pages ?? []);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, baseUrl, launchPublicId]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await fetch(`${baseUrl}/v1/launches/${launchPublicId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      router.push('/launches');
    } catch {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  function handleTabChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', value);
    router.push(`?${params.toString()}`);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-12">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Carregando...
      </div>
    );
  }

  if (!launch) {
    return (
      <div className="space-y-4">
        <Link
          href="/launches"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Voltar para lançamentos
        </Link>
        <p className="text-sm text-muted-foreground">
          Lançamento não encontrado.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/launches"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Voltar para lançamentos
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{launch.name}</h1>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[launch.status] ?? ''}`}
            >
              {STATUS_LABELS[launch.status] ?? launch.status}
            </span>
          </div>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            {launch.public_id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild>
            <Link href={`/launches/${launchPublicId}/events/live`}>
              <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
              Eventos ao vivo
            </Link>
          </Button>
          <Button variant="outline" size="icon" onClick={() => setDeleteOpen(true)} aria-label="Excluir lançamento">
            <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {deleteOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-0 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-lg border p-6 shadow-lg max-w-sm w-full space-y-4 relative">
            <h2 className="text-lg font-semibold">Excluir lançamento?</h2>
            <p className="text-sm text-muted-foreground">
              Esta ação é irreversível. O lançamento <span className="font-medium text-foreground">{launch.name}</span> e todos os seus dados serão removidos permanentemente.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Excluir'}
              </Button>
            </div>
          </div>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList aria-label="Navegação do launch">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="funil">Funil</TabsTrigger>
          <TabsTrigger value="pages">Pages</TabsTrigger>
          <TabsTrigger value="eventos">Eventos</TabsTrigger>
          <TabsTrigger value="audiences">Audiences</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <TabOverview
            launch={launch}
            accessToken={accessToken}
            baseUrl={baseUrl}
          />
        </TabsContent>

        <TabsContent value="pages">
          <TabPages
            pages={pages}
            launchPublicId={launchPublicId}
            blueprint={launch?.funnel_blueprint ?? null}
            accessToken={accessToken}
            baseUrl={baseUrl}
            onPageDeleted={() => void refreshPages()}
          />
        </TabsContent>

        <TabsContent value="eventos">
          <TabEventos
            launchPublicId={launchPublicId}
            accessToken={accessToken}
            baseUrl={baseUrl}
          />
        </TabsContent>

        <TabsContent value="audiences">
          <p className="text-sm text-muted-foreground py-4">
            Em breve — audiences vinculadas a este launch.
          </p>
        </TabsContent>

        <TabsContent value="performance">
          <p className="text-sm text-muted-foreground py-4">
            Métricas disponíveis em breve.
          </p>
        </TabsContent>

        <TabsContent value="funil">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Funil configurável</CardTitle>
              <CardDescription>
                Visualize e edite os estágios do funil deste lançamento.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href={`/launches/${launchPublicId}/funnel`}>
                  Abrir editor de funil
                </Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
