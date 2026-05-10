'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { edgeFetch } from '@/lib/api-client';
import { Copy, Heart, Loader2, RefreshCw, Users, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

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

interface Launch {
  public_id: string;
  name: string;
  config?: {
    metaCampaignPrefix?: string;
  };
}

interface MetaAudience {
  id: string;
  meta_audience_id: string;
  name: string;
  subtype: string;
  approx_count: number | null;
  delivery_status_code: number | null;
  delivery_status_description: string | null;
  synced_at: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type AudienceSubtype = 'CUSTOM' | 'WEBSITE' | 'IG_BUSINESS' | 'LOOKALIKE';

const SUBTYPE_META: Record<
  AudienceSubtype,
  { label: string; Icon: React.ElementType; color: string }
> = {
  CUSTOM: {
    label: 'Listas',
    Icon: Users,
    color: 'text-slate-600 bg-slate-100',
  },
  WEBSITE: {
    label: 'Pixel / Comportamento',
    Icon: Zap,
    color: 'text-blue-600 bg-blue-50',
  },
  IG_BUSINESS: {
    label: 'Engajamento IG',
    Icon: Heart,
    color: 'text-pink-600 bg-pink-50',
  },
  LOOKALIKE: {
    label: 'Lookalikes',
    Icon: Copy,
    color: 'text-purple-600 bg-purple-50',
  },
};

function getSubtypeMeta(subtype: string) {
  return (
    SUBTYPE_META[subtype as AudienceSubtype] ?? {
      label: subtype,
      Icon: Users,
      color: 'text-gray-600 bg-gray-100',
    }
  );
}

function formatApproxCount(approxCount: number | null): string {
  if (approxCount === null || approxCount <= 1000) return '< 1.000';
  return `~${approxCount.toLocaleString('pt-BR')}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hour}:${min}`;
}

function statusBadge(code: number | null) {
  if (code === 200)
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200">
        Pronta
      </Badge>
    );
  if (code === 300)
    return (
      <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">
        Muito pequena
      </Badge>
    );
  return <Badge className="bg-red-100 text-red-800 border-red-200">Erro</Badge>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AudiencesPage() {
  const token = useAccessToken();

  const [launches, setLaunches] = useState<Launch[]>([]);
  const [loadingLaunches, setLoadingLaunches] = useState(true);

  const [selectedLaunchId, setSelectedLaunchId] = useState<string>('');
  const [prefix, setPrefix] = useState('');
  const [editingPrefix, setEditingPrefix] = useState('');
  const [savingPrefix, setSavingPrefix] = useState(false);

  const [audiences, setAudiences] = useState<MetaAudience[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [loadingAudiences, setLoadingAudiences] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // ── Fetch launches ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!token) return;
    setLoadingLaunches(true);
    edgeFetch('/v1/launches', token)
      .then((r) => r.json())
      .then((data: { launches?: Launch[] }) => {
        setLaunches(data.launches ?? []);
      })
      .catch(() => {
        toast.error('Erro ao carregar launches');
      })
      .finally(() => setLoadingLaunches(false));
  }, [token]);

  // ── When launch selected: load stored prefix + fetch audiences ──────────────

  useEffect(() => {
    if (!selectedLaunchId) {
      setPrefix('');
      setEditingPrefix('');
      setAudiences([]);
      setLastSyncedAt(null);
      return;
    }

    // Check localStorage for saved prefix
    const stored =
      localStorage.getItem(`meta_prefix_${selectedLaunchId}`) ?? '';
    setPrefix(stored);
    setEditingPrefix(stored);

    // Fetch audiences
    fetchAudiences(selectedLaunchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLaunchId]);

  // ── Fetch audiences ─────────────────────────────────────────────────────────

  async function fetchAudiences(launchId: string) {
    if (!token) return;
    setLoadingAudiences(true);
    try {
      const res = await edgeFetch(
        `/v1/launches/${launchId}/meta-audiences`,
        token,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: {
        audiences?: MetaAudience[];
        last_synced_at?: string | null;
      } = await res.json();
      setAudiences(data.audiences ?? []);
      setLastSyncedAt(data.last_synced_at ?? null);
    } catch {
      toast.error('Erro ao carregar audiências');
      setAudiences([]);
    } finally {
      setLoadingAudiences(false);
    }
  }

  // ── Save prefix ─────────────────────────────────────────────────────────────

  async function handleSavePrefix() {
    if (!selectedLaunchId) return;
    setSavingPrefix(true);
    try {
      localStorage.setItem(
        `meta_prefix_${selectedLaunchId}`,
        editingPrefix.trim(),
      );
      setPrefix(editingPrefix.trim());
      toast.success('Prefixo salvo');
      // Trigger sync after saving
      await handleSync();
    } finally {
      setSavingPrefix(false);
    }
  }

  // ── Sync ────────────────────────────────────────────────────────────────────

  async function handleSync() {
    if (!selectedLaunchId || !token) return;
    setSyncing(true);
    try {
      const res = await edgeFetch(
        `/v1/launches/${selectedLaunchId}/meta-audiences/sync`,
        token,
        { method: 'POST', body: JSON.stringify({ prefix }) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { synced?: number } = await res.json();
      toast.success(
        `Sincronização concluída — ${data.synced ?? 0} audiência(s) atualizadas`,
      );
      await fetchAudiences(selectedLaunchId);
    } catch {
      toast.error('Erro ao sincronizar audiências');
    } finally {
      setSyncing(false);
    }
  }

  // ── Group audiences by subtype ──────────────────────────────────────────────

  const grouped = audiences.reduce<Record<string, MetaAudience[]>>(
    (acc, audience) => {
      const key = audience.subtype;
      if (!acc[key]) acc[key] = [];
      acc[key].push(audience);
      return acc;
    },
    {},
  );

  // Order groups: CUSTOM, WEBSITE, IG_BUSINESS, LOOKALIKE, then the rest
  const groupOrder = ['CUSTOM', 'WEBSITE', 'IG_BUSINESS', 'LOOKALIKE'];
  const sortedGroups = [
    ...groupOrder.filter((k) => grouped[k]),
    ...Object.keys(grouped).filter((k) => !groupOrder.includes(k)),
  ];

  const selectedLaunch = launches.find((l) => l.public_id === selectedLaunchId);
  const prefixConfigured = Boolean(prefix);
  const isBusy = syncing || savingPrefix;

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Audiences</h1>
        <p className="text-sm text-muted-foreground">
          Custom Audiences do Meta Ads associadas a um launch
        </p>
      </div>

      {/* Launch selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Launch</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingLaunches ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando launches...
            </div>
          ) : (
            <div className="space-y-1">
              <label
                htmlFor="launch-select"
                className="text-sm font-medium leading-none"
              >
                Selecione o launch
              </label>
              <select
                id="launch-select"
                value={selectedLaunchId}
                onChange={(e) => setSelectedLaunchId(e.target.value)}
                className="flex h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Escolha um launch...</option>
                {launches.map((l) => (
                  <option key={l.public_id} value={l.public_id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Prefix config (only when launch selected) */}
          {selectedLaunch && (
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm font-medium leading-none">
                Prefixo da campanha Meta
              </p>
              {prefixConfigured ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
                    {prefix}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSync}
                    disabled={isBusy}
                  >
                    {syncing ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-1" />
                    )}
                    Sincronizar agora
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPrefix('')}
                    disabled={isBusy}
                  >
                    Alterar prefixo
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Informe o prefixo das campanhas no Meta Ads (ex: WCS-JUN26).
                    Audiences cujo nome começa com esse prefixo serão exibidas
                    aqui.
                  </p>
                  <div className="flex items-center gap-2 max-w-sm">
                    <input
                      type="text"
                      placeholder="Ex: WCS-JUN26"
                      value={editingPrefix}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setEditingPrefix(e.target.value.toUpperCase())
                      }
                      disabled={isBusy}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <Button
                      size="sm"
                      onClick={handleSavePrefix}
                      disabled={isBusy || !editingPrefix.trim()}
                    >
                      {savingPrefix ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      ) : null}
                      Salvar e Sincronizar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audiences list */}
      {selectedLaunchId && (
        <div className="space-y-4">
          {/* Last synced + meta */}
          {lastSyncedAt && (
            <p className="text-xs text-muted-foreground">
              Última sincronização: {formatDateTime(lastSyncedAt)}
            </p>
          )}

          {loadingAudiences ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" />
              Carregando audiências...
            </div>
          ) : audiences.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Nenhuma audiência encontrada. Verifique se o prefixo está
                  correto.
                </p>
              </CardContent>
            </Card>
          ) : (
            sortedGroups.map((subtype) => {
              const group = grouped[subtype] ?? [];
              const { label, Icon, color } = getSubtypeMeta(subtype);
              return (
                <div key={subtype} className="space-y-2">
                  {/* Group header */}
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${color}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {group.length} audiência{group.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Audience cards */}
                  <div className="grid gap-2">
                    {group.map((audience) => (
                      <Card
                        key={audience.id}
                        className="border border-border shadow-none"
                      >
                        <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {audience.name}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Tamanho aproximado:{' '}
                              {formatApproxCount(audience.approx_count)}
                            </p>
                          </div>
                          <div className="shrink-0">
                            {statusBadge(audience.delivery_status_code)}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
