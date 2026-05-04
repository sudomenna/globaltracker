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
  FileText,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

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
}

interface Page {
  public_id: string;
  name: string;
  status: string;
  role?: string;
  created_at: string;
}

interface Event {
  public_id?: string;
  event_name: string;
  created_at: string;
  lead_id?: string;
}

// ─── Guru Mapping types ───────────────────────────────────────────────────────

interface GuruProductEntry {
  launch_public_id: string;
  funnel_role: string;
}

type GuruProductLaunchMap = Record<string, GuruProductEntry>;

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

const GURU_FUNNEL_ROLES = [
  { value: 'workshop', label: 'Workshop' },
  { value: 'main_offer', label: 'Oferta principal' },
  { value: 'outro', label: 'Outro' },
] as const;

const VALID_TABS = [
  'overview',
  'pages',
  'eventos',
  'audiences',
  'performance',
  'funil',
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

// ─── GuruMappingPanel ─────────────────────────────────────────────────────────

/**
 * T-FUNIL-023: Painel "Mapeamento Guru" — exibido na tab Overview do launch.
 * Lê workspace.config.integrations.guru.product_launch_map via Supabase,
 * filtrando apenas entradas associadas a este launch_public_id.
 * Permite adicionar e remover mapeamentos via PATCH /v1/workspace/config.
 *
 * BR-RBAC-002: workspace_id como âncora multi-tenant — o endpoint já verifica
 *   OPERATOR/ADMIN server-side; botão de edição é sempre visível (sem role CP
 *   disponível client-side neste momento; segurança garantida no servidor).
 */
function GuruMappingPanel({
  launchPublicId,
  accessToken,
  baseUrl,
}: {
  launchPublicId: string;
  accessToken: string;
  baseUrl: string;
}) {
  // Estado do painel
  const [mappings, setMappings] = useState<
    Array<{ productId: string; funnel_role: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  // fullMap guarda o mapa completo (todos os launches) para re-emitir sem perder entradas de outros launches
  const fullMapRef = useRef<GuruProductLaunchMap>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [productId, setProductId] = useState('');
  const [funnelRole, setFunnelRole] = useState<string>('workshop');
  const [formError, setFormError] = useState<string | null>(null);

  // Lê workspace.config via Supabase (workspaces.config é JSONB acessível via RLS)
  const loadMappings = useCallback(async () => {
    try {
      const supabase = createSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Busca workspace_id via workspace_members
      const { data: memberRow } = await supabase
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .is('removed_at', null)
        .order('joined_at', { ascending: true })
        .limit(1)
        .single();

      if (!memberRow) return;

      // Busca config do workspace
      const { data: wsRow } = await supabase
        .from('workspaces')
        .select('config')
        .eq('id', memberRow.workspace_id)
        .single();

      const config = wsRow?.config as
        | {
            integrations?: {
              guru?: { product_launch_map?: GuruProductLaunchMap };
            };
          }
        | null
        | undefined;

      const map = config?.integrations?.guru?.product_launch_map ?? {};
      fullMapRef.current = map;

      // Filtra entradas deste launch
      const filtered = Object.entries(map)
        .filter(([, entry]) => entry.launch_public_id === launchPublicId)
        .map(([pid, entry]) => ({
          productId: pid,
          funnel_role: entry.funnel_role,
        }));

      setMappings(filtered);
    } catch {
      // silencioso — painel simplesmente mostra vazio
    } finally {
      setLoading(false);
    }
  }, [launchPublicId]);

  useEffect(() => {
    void loadMappings();
  }, [loadMappings]);

  // Envia o mapa completo atualizado via PATCH /v1/workspace/config
  async function patchMap(newMap: GuruProductLaunchMap) {
    const res = await fetch(`${baseUrl}/v1/workspace/config`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        integrations: { guru: { product_launch_map: newMap } },
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(body.message ?? `HTTP ${res.status}`);
    }
  }

  async function handleAdd() {
    setFormError(null);
    const trimmed = productId.trim();
    if (!trimmed) {
      setFormError('Product ID é obrigatório.');
      return;
    }
    if (fullMapRef.current[trimmed]) {
      setFormError('Este Product ID já está mapeado.');
      return;
    }
    setSaving(true);
    try {
      const newMap: GuruProductLaunchMap = {
        ...fullMapRef.current,
        [trimmed]: {
          launch_public_id: launchPublicId,
          funnel_role: funnelRole,
        },
      };
      await patchMap(newMap);
      fullMapRef.current = newMap;
      setMappings((prev) => [
        ...prev,
        { productId: trimmed, funnel_role: funnelRole },
      ]);
      setProductId('');
      setFunnelRole('workshop');
      setModalOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Erro ao salvar mapeamento.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(pid: string) {
    if (!window.confirm(`Remover mapeamento do produto "${pid}"?`)) {
      return;
    }
    try {
      const newMap: GuruProductLaunchMap = { ...fullMapRef.current };
      delete newMap[pid];
      await patchMap(newMap);
      fullMapRef.current = newMap;
      setMappings((prev) => prev.filter((m) => m.productId !== pid));
    } catch (err) {
      window.alert(
        `Erro ao remover: ${err instanceof Error ? err.message : 'Erro desconhecido'}`,
      );
    }
  }

  function handleModalClose() {
    setModalOpen(false);
    setProductId('');
    setFunnelRole('workshop');
    setFormError(null);
  }

  const funnelRoleLabel = (role: string) =>
    GURU_FUNNEL_ROLES.find((r) => r.value === role)?.label ?? role;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Mapeamento Guru</CardTitle>
            <CardDescription>
              Associe IDs de produto do Digital Manager Guru a este lançamento.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setModalOpen(true)}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Adicionar produto
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Carregando mapeamentos...
            </div>
          ) : mappings.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Nenhum produto mapeado.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-2 pr-4 font-medium">
                      Product ID
                    </th>
                    <th className="text-left py-2 pr-4 font-medium">
                      Papel no funil
                    </th>
                    <th className="text-left py-2 pr-4 font-medium">Launch</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mappings.map((m) => (
                    <tr key={m.productId}>
                      <td className="py-3 pr-4 font-mono text-xs">
                        {m.productId}
                      </td>
                      <td className="py-3 pr-4">
                        {funnelRoleLabel(m.funnel_role)}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">
                        {launchPublicId}
                      </td>
                      <td className="py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive h-7 px-2"
                          onClick={() => void handleRemove(m.productId)}
                          aria-label={`Remover mapeamento de ${m.productId}`}
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

      {/* Modal "Adicionar produto" — <dialog> nativo conforme convenção do projeto */}
      {modalOpen && (
        <dialog
          open
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          aria-labelledby="guru-modal-title"
          aria-modal="true"
        >
          <div className="bg-card rounded-lg shadow-lg w-full max-w-sm p-6 space-y-4">
            <h2 id="guru-modal-title" className="text-base font-semibold">
              Adicionar produto Guru
            </h2>

            <div className="space-y-3">
              <div className="space-y-1">
                <label
                  htmlFor="guru-product-id"
                  className="text-sm font-medium"
                >
                  Product ID
                </label>
                <input
                  id="guru-product-id"
                  type="text"
                  placeholder="prod_workshop_xyz"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={saving}
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="guru-funnel-role"
                  className="text-sm font-medium"
                >
                  Papel no funil
                </label>
                <select
                  id="guru-funnel-role"
                  value={funnelRole}
                  onChange={(e) => setFunnelRole(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={saving}
                >
                  {GURU_FUNNEL_ROLES.map((r) => (
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
                onClick={handleModalClose}
                disabled={saving}
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={() => void handleAdd()}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2
                      className="mr-1.5 h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    Salvando...
                  </>
                ) : (
                  'Confirmar'
                )}
              </Button>
            </div>
          </div>
        </dialog>
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

      {/* T-FUNIL-023: Painel de mapeamento Guru — após conteúdo de overview */}
      <GuruMappingPanel
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
}: {
  pages: Page[];
  launchPublicId: string;
}) {
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
            {pages.map((p) => (
              <li key={p.public_id}>
                <Link
                  href={`/launches/${launchPublicId}/pages/${p.public_id}`}
                  className="flex items-center justify-between py-3 -mx-2 px-2 rounded-md hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div>
                    <p className="text-sm font-medium font-mono">
                      {p.public_id}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {p.status}
                    </p>
                  </div>
                  {p.role && (
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${ROLE_COLORS[p.role] ?? 'bg-gray-100 text-gray-700'}`}
                    >
                      {p.role}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
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

  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

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
        <Button asChild>
          <Link href={`/launches/${launchPublicId}/events/live`}>
            <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
            Eventos ao vivo
          </Link>
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList aria-label="Navegação do launch">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="pages">Pages</TabsTrigger>
          <TabsTrigger value="eventos">Eventos</TabsTrigger>
          <TabsTrigger value="audiences">Audiences</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="funil">Funil</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <TabOverview
            launch={launch}
            accessToken={accessToken}
            baseUrl={baseUrl}
          />
        </TabsContent>

        <TabsContent value="pages">
          <TabPages pages={pages} launchPublicId={launchPublicId} />
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
