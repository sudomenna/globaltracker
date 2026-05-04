'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Stage {
  slug: string;
  label?: string;
  is_recurring: boolean;
  source_events: string[];
  source_event_filters?: Record<string, string>;
}

interface FunnelBlueprint {
  stages?: Stage[];
  [key: string]: unknown;
}

interface LaunchRow {
  id: string;
  public_id: string;
  name: string;
  status: string;
  config: unknown;
  funnel_blueprint: FunnelBlueprint | null;
  created_at: string;
}

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FunnelPage() {
  const params = useParams<{ launch_public_id: string }>();
  const launchPublicId = params.launch_public_id;
  const accessToken = useAccessToken();

  const [launchId, setLaunchId] = useState<string | null>(null);
  const [launchName, setLaunchName] = useState<string>('');
  const [blueprint, setBlueprint] = useState<FunnelBlueprint | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<Array<{ slug: string; name: string }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [scaffolding, setScaffolding] = useState(false);

  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  async function fetchLaunches(cancelled: { value: boolean }) {
    const res = await fetch(`${baseUrl}/v1/launches`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { launches?: LaunchRow[] };
    const found = (body.launches ?? []).find(
      (l) => l.public_id === launchPublicId,
    );
    if (!cancelled.value && found) {
      setLaunchId(found.id);
      setLaunchName(found.name);
      const bp = found.funnel_blueprint ?? null;
      setBlueprint(bp);
      setStages(bp?.stages ?? []);
    }
  }

  useEffect(() => {
    if (!accessToken) return;
    const cancelled = { value: false };
    (async () => {
      try {
        await fetchLaunches(cancelled);

        const tplRes = await fetch(`${baseUrl}/v1/funnel-templates`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (tplRes.ok) {
          const tplBody = (await tplRes.json()) as {
            templates?: Array<{ slug: string; name: string; status: string }>;
          };
          const active = (tplBody.templates ?? [])
            .filter((t) => t.status === 'active')
            .map(({ slug, name }) => ({ slug, name }));
          if (!cancelled.value) setTemplates(active);
        }
      } catch {
        // silent
      } finally {
        if (!cancelled.value) setLoading(false);
      }
    })();
    return () => {
      cancelled.value = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, baseUrl, launchPublicId]);

  async function handleScaffold() {
    if (!selectedTemplate) return;
    setScaffolding(true);
    try {
      const res = await fetch(
        `${baseUrl}/v1/launches/${launchPublicId}/scaffold`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ funnel_template_slug: selectedTemplate }),
        },
      );
      if (res.ok) {
        await fetchLaunches({ value: false });
        toast.success('Template aplicado com sucesso');
      } else {
        toast.error('Erro ao aplicar template');
      }
    } catch {
      toast.error('Erro ao aplicar template');
    } finally {
      setScaffolding(false);
    }
  }

  function handleLabelChange(index: number, value: string) {
    setStages((prev) =>
      prev.map((s, i) => (i === index ? { ...s, label: value } : s)),
    );
  }

  function handleRecurringChange(index: number, checked: boolean) {
    setStages((prev) =>
      prev.map((s, i) => (i === index ? { ...s, is_recurring: checked } : s)),
    );
  }

  async function handleSave() {
    if (!launchId) return;
    setSaving(true);
    try {
      const updatedBlueprint: FunnelBlueprint = {
        ...(blueprint ?? {}),
        stages,
      };
      const res = await fetch(`${baseUrl}/v1/launches/${launchId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ funnel_blueprint: updatedBlueprint }),
      });
      if (res.ok) {
        setBlueprint(updatedBlueprint);
        toast.success('Funil salvo');
      } else {
        toast.error('Erro ao salvar funil');
      }
    } catch {
      toast.error('Erro ao salvar funil');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-12">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/launches/${launchPublicId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Voltar para {launchName || launchPublicId}
      </Link>

      <div>
        <h1 className="text-2xl font-semibold">
          Funil — {launchName || launchPublicId}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Edite os estágios do funil deste lançamento.
        </p>
      </div>

      {stages.length === 0 ? (
        <Card>
          <CardContent className="py-8 space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              Este lançamento ainda não tem estágios de funil configurados.
            </p>
            {templates.length > 0 && (
              <div className="flex flex-col gap-3 max-w-sm mx-auto">
                <select
                  value={selectedTemplate}
                  onChange={(e) => setSelectedTemplate(e.target.value)}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Selecione um template</option>
                  {templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() => void handleScaffold()}
                  disabled={!selectedTemplate || scaffolding}
                >
                  {scaffolding ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />
                      Aplicando...
                    </>
                  ) : (
                    'Aplicar template'
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            {stages.map((stage, idx) => (
              <Card key={stage.slug}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-mono text-muted-foreground">
                    {stage.slug}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <label
                      htmlFor={`stage-label-${idx}`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Label
                    </label>
                    <input
                      id={`stage-label-${idx}`}
                      type="text"
                      value={stage.label ?? stage.slug}
                      onChange={(e) => handleLabelChange(idx, e.target.value)}
                      className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </div>

                  {stage.source_events.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        Eventos de entrada
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {stage.source_events.map((ev) => (
                          <Badge
                            key={ev}
                            variant="secondary"
                            className="text-xs font-mono"
                          >
                            {ev}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {stage.source_event_filters &&
                    Object.keys(stage.source_event_filters).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Filtros
                        </p>
                        <Badge variant="outline" className="text-xs font-mono">
                          {JSON.stringify(stage.source_event_filters)}
                        </Badge>
                      </div>
                    )}

                  <div className="flex items-start gap-2">
                    <input
                      id={`stage-recurring-${idx}`}
                      type="checkbox"
                      checked={stage.is_recurring}
                      onChange={(e) =>
                        handleRecurringChange(idx, e.target.checked)
                      }
                      className="h-4 w-4 mt-0.5 cursor-pointer"
                    />
                    <div>
                      <label
                        htmlFor={`stage-recurring-${idx}`}
                        className="text-sm cursor-pointer"
                      >
                        Recorrente
                      </label>
                      <p className="text-xs text-muted-foreground">
                        {stage.is_recurring
                          ? 'O lead pode entrar neste estágio múltiplas vezes.'
                          : 'O lead entra neste estágio apenas uma vez.'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                Salvando...
              </>
            ) : (
              'Salvar alterações'
            )}
          </Button>
        </>
      )}
    </div>
  );
}
