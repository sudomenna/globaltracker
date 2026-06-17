'use client';

import { Badge } from '@/components/ui/badge';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Step {
  delay_min: number;
  template_id: string;
}

interface Campaign {
  id: string;
  launch_public_id: string;
  launch_name: string;
  name: string;
  trigger_funnel_role: string | null;
  trigger_product_id: string | null;
  product_name: string | null;
  external_provider: string | null;
  external_product_id: string | null;
  steps: Step[];
  send_window_start: string;
  send_window_end: string;
  send_window_tz: string;
  recoverable_statuses: string[];
  active: boolean;
  unnichat_sent_tag_id: string | null;
  created_at: string;
  stats?: {
    jobs_total: number;
    sent: number;
    queued: number;
    failed: number;
    suppressed: number;
  };
}

interface Template {
  id: string;
  name: string;
  unnichat_template_id: string;
  body_params: Array<{ type: string; fallback?: string }>;
  url_button_params: Array<{ type: string; fallback?: string }>;
  active?: boolean;
  created_at: string;
}

interface LaunchOpt {
  public_id: string;
  name: string;
}

interface ProductOpt {
  id: string;
  name: string;
  external_provider: string;
  external_product_id: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_OPTIONS = [
  'main_offer',
  'bait_offer',
  'main_checkout',
  'bait_order_bump',
  'order_bump',
];

const STATUS_OPTIONS = [
  'CART_ABANDONED',
  'WAITING',
  'PENDING',
  'CANCELED',
  'REJECTED',
  'REFUSED',
];

const DEFAULT_STATUSES = ['CART_ABANDONED', 'WAITING'];

async function getAccessToken(): Promise<string> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  canEdit: boolean;
}

export function RecoveryClient({ canEdit }: Props) {
  const [tab, setTab] = useState<'campaigns' | 'templates'>('campaigns');
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [launches, setLaunches] = useState<LaunchOpt[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(
    null,
  );

  const [campaignModal, setCampaignModal] = useState<Campaign | 'new' | null>(
    null,
  );
  const [templateModal, setTemplateModal] = useState<Template | 'new' | null>(
    null,
  );

  const pushToast = (msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const token = await getAccessToken();
    try {
      const [cRes, tRes, lRes, pRes] = await Promise.all([
        edgeFetch('/v1/recovery/campaigns', token),
        edgeFetch('/v1/recovery/templates', token),
        edgeFetch('/v1/launches', token),
        edgeFetch('/v1/products?limit=100', token),
      ]);
      const cBody = await cRes.json().catch(() => ({}));
      const tBody = await tRes.json().catch(() => ({}));
      const lBody = await lRes.json().catch(() => ({}));
      const pBody = await pRes.json().catch(() => ({}));
      setCampaigns(cBody.items ?? []);
      setTemplates(tBody.items ?? []);
      const lItems = lBody.items ?? lBody.launches ?? lBody ?? [];
      setLaunches(
        (Array.isArray(lItems) ? lItems : []).map(
          (l: { public_id?: string; launch_public_id?: string; name: string }) => ({
            public_id: l.public_id ?? l.launch_public_id ?? '',
            name: l.name,
          }),
        ),
      );
      setProducts(pBody.items ?? []);
    } catch {
      pushToast('Falha ao carregar dados. Verifique o Edge.', true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── actions ──
  const toggleActive = async (c: Campaign) => {
    const token = await getAccessToken();
    const res = await edgeFetch(`/v1/recovery/campaigns/${c.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ active: !c.active }),
    });
    if (res.ok) {
      setCampaigns((prev) =>
        prev.map((x) => (x.id === c.id ? { ...x, active: !x.active } : x)),
      );
    } else {
      pushToast('Falha ao alterar status.', true);
    }
  };

  const deleteCampaign = async (c: Campaign) => {
    if (!confirm(`Excluir a campanha "${c.name}"?`)) return;
    const token = await getAccessToken();
    const res = await edgeFetch(`/v1/recovery/campaigns/${c.id}`, token, {
      method: 'DELETE',
    });
    if (res.ok) {
      setCampaigns((prev) => prev.filter((x) => x.id !== c.id));
      pushToast('Campanha excluída.');
    } else {
      pushToast('Falha ao excluir.', true);
    }
  };

  const deleteTemplate = async (t: Template) => {
    if (!confirm(`Excluir o template "${t.name}"?`)) return;
    const token = await getAccessToken();
    const res = await edgeFetch(`/v1/recovery/templates/${t.id}`, token, {
      method: 'DELETE',
    });
    if (res.ok) {
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
      pushToast('Template excluído.');
    } else {
      const body = await res.json().catch(() => ({}));
      pushToast(body.message ?? 'Falha ao excluir template.', true);
    }
  };

  // ── grouping ──
  const byLaunch = campaigns.reduce<Record<string, Campaign[]>>((acc, c) => {
    const key = `${c.launch_name} (${c.launch_public_id})`;
    (acc[key] ??= []).push(c);
    return acc;
  }, {});

  const templateName = (id: string) =>
    templates.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* tabs */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-md border p-1 text-sm">
          {(['campaigns', 'templates'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 ${
                tab === t
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground'
              }`}
            >
              {t === 'campaigns' ? 'Campanhas' : 'Templates'}
            </button>
          ))}
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() =>
              tab === 'campaigns'
                ? setCampaignModal('new')
                : setTemplateModal('new')
            }
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            {tab === 'campaigns' ? 'Nova campanha' : 'Novo template'}
          </button>
        )}
      </div>

      {/* CAMPAIGNS */}
      {tab === 'campaigns' && (
        <div className="space-y-6">
          {Object.keys(byLaunch).length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhuma campanha de recovery. Crie a primeira.
            </p>
          )}
          {Object.entries(byLaunch).map(([launch, list]) => (
            <div key={launch}>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                {launch}
              </h2>
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Campanha</th>
                      <th className="px-3 py-2">Gatilho</th>
                      <th className="px-3 py-2">Cadência</th>
                      <th className="px-3 py-2">Janela</th>
                      <th className="px-3 py-2">Jobs</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{c.name}</td>
                        <td className="px-3 py-2">
                          {c.trigger_product_id ? (
                            <Badge variant="secondary">
                              produto: {c.product_name}
                              {c.external_provider
                                ? ` (${c.external_provider})`
                                : ''}
                            </Badge>
                          ) : (
                            <Badge variant="outline">
                              role: {c.trigger_funnel_role}
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {c.steps
                            .map(
                              (s) =>
                                `+${s.delay_min}min → ${templateName(
                                  s.template_id,
                                )}`,
                            )
                            .join(', ')}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {c.send_window_start?.slice(0, 5)}–
                          {c.send_window_end?.slice(0, 5)}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {c.stats
                            ? `${c.stats.sent}✓ ${c.stats.failed}✗ ${c.stats.suppressed}⊘`
                            : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => toggleActive(c)}
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              c.active
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {c.active ? 'Ativo' : 'Inativo'}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {canEdit && (
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setCampaignModal(c)}
                                className="text-primary hover:underline"
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteCampaign(c)}
                                className="text-destructive"
                                aria-label="Excluir"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TEMPLATES */}
      {tab === 'templates' && (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">ID Unnichat</th>
                <th className="px-3 py-2">Placeholders (body)</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-4 text-center text-muted-foreground"
                  >
                    Nenhum template. Registre o primeiro.
                  </td>
                </tr>
              )}
              {templates.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="px-3 py-2 font-medium">{t.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {t.unnichat_template_id}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {(t.body_params ?? []).map((p) => p.type).join(', ') || '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setTemplateModal(t)}
                          className="text-primary hover:underline"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteTemplate(t)}
                          className="text-destructive"
                          aria-label="Excluir"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* MODALS */}
      {campaignModal && (
        <CampaignModal
          initial={campaignModal === 'new' ? null : campaignModal}
          launches={launches}
          products={products}
          templates={templates}
          onClose={() => setCampaignModal(null)}
          onSaved={(msg) => {
            setCampaignModal(null);
            pushToast(msg);
            void load();
          }}
          onError={(msg) => pushToast(msg, true)}
        />
      )}
      {templateModal && (
        <TemplateModal
          initial={templateModal === 'new' ? null : templateModal}
          onClose={() => setTemplateModal(null)}
          onSaved={(msg) => {
            setTemplateModal(null);
            pushToast(msg);
            void load();
          }}
          onError={(msg) => pushToast(msg, true)}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 rounded-md px-4 py-2 text-sm text-white shadow-lg ${
            toast.err ? 'bg-destructive' : 'bg-green-600'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── Campaign modal ───────────────────────────────────────────────────────────

function CampaignModal({
  initial,
  launches,
  products,
  templates,
  onClose,
  onSaved,
  onError,
}: {
  initial: Campaign | null;
  launches: LaunchOpt[];
  products: ProductOpt[];
  templates: Template[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [launchPid, setLaunchPid] = useState(
    initial?.launch_public_id ?? launches[0]?.public_id ?? '',
  );
  const [triggerType, setTriggerType] = useState<'role' | 'product'>(
    initial?.trigger_product_id ? 'product' : 'role',
  );
  const [role, setRole] = useState(
    initial?.trigger_funnel_role ?? 'bait_offer',
  );
  const [productId, setProductId] = useState(
    initial?.trigger_product_id ?? products[0]?.id ?? '',
  );
  const [steps, setSteps] = useState<Step[]>(
    initial?.steps?.length
      ? initial.steps
      : [{ delay_min: 7, template_id: templates[0]?.id ?? '' }],
  );
  const [statuses, setStatuses] = useState<string[]>(
    initial?.recoverable_statuses ?? DEFAULT_STATUSES,
  );
  const [winStart, setWinStart] = useState(
    initial?.send_window_start?.slice(0, 5) ?? '07:15',
  );
  const [winEnd, setWinEnd] = useState(
    initial?.send_window_end?.slice(0, 5) ?? '22:30',
  );
  const [tz, setTz] = useState(
    initial?.send_window_tz ?? 'America/Sao_Paulo',
  );
  const [sentTag, setSentTag] = useState(initial?.unnichat_sent_tag_id ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const toggleStatus = (s: string) =>
    setStatuses((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );

  const save = async () => {
    setErr('');
    if (!name.trim()) return setErr('Nome é obrigatório.');
    if (!launchPid) return setErr('Selecione um lançamento.');
    if (triggerType === 'product' && !productId)
      return setErr('Selecione um produto.');
    if (steps.some((s) => !s.template_id))
      return setErr('Cada passo precisa de um template.');
    if (statuses.length === 0) return setErr('Selecione ≥1 status.');

    const payload: Record<string, unknown> = {
      launch_public_id: launchPid,
      name: name.trim(),
      trigger_funnel_role: triggerType === 'role' ? role : null,
      trigger_product_id: triggerType === 'product' ? productId : null,
      steps: steps.map((s) => ({
        delay_min: Number(s.delay_min),
        template_id: s.template_id,
      })),
      send_window_start: `${winStart}:00`,
      send_window_end: `${winEnd}:00`,
      send_window_tz: tz,
      recoverable_statuses: statuses,
      active,
      unnichat_sent_tag_id: sentTag.trim() || null,
    };

    setSaving(true);
    try {
      const token = await getAccessToken();
      const res = await edgeFetch(
        initial
          ? `/v1/recovery/campaigns/${initial.id}`
          : '/v1/recovery/campaigns',
        token,
        { method: initial ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.message ?? 'Falha ao salvar campanha.');
        return;
      }
      onSaved(initial ? 'Campanha atualizada.' : 'Campanha criada.');
    } catch {
      onError('Erro de rede ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Editar campanha' : 'Nova campanha'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nome">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Lançamento">
          <select className={inputCls} value={launchPid} onChange={(e) => setLaunchPid(e.target.value)}>
            {launches.map((l) => (
              <option key={l.public_id} value={l.public_id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Gatilho">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input type="radio" checked={triggerType === 'role'} onChange={() => setTriggerType('role')} />
              Por papel (role)
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={triggerType === 'product'} onChange={() => setTriggerType('product')} />
              Por produto
            </label>
          </div>
        </Field>
        {triggerType === 'role' ? (
          <Field label="Funnel role">
            <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Produto">
            <select className={inputCls} value={productId} onChange={(e) => setProductId(e.target.value)}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.external_provider} {p.external_product_id})
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Cadência (passos)">
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">+</span>
                <input
                  type="number"
                  min={0}
                  className={`${inputCls} w-20`}
                  value={s.delay_min}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, delay_min: Number(e.target.value) } : x,
                      ),
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">min →</span>
                <select
                  className={`${inputCls} flex-1`}
                  value={s.template_id}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, template_id: e.target.value } : x,
                      ),
                    )
                  }
                >
                  <option value="">— template —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                    className="text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setSteps((prev) => [...prev, { delay_min: 60, template_id: '' }])
              }
              className="text-xs text-primary hover:underline"
            >
              + adicionar passo
            </button>
          </div>
        </Field>

        <Field label="Statuses recuperáveis">
          <div className="flex flex-wrap gap-2 text-xs">
            {STATUS_OPTIONS.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="checkbox" checked={statuses.includes(s)} onChange={() => toggleStatus(s)} />
                {s}
              </label>
            ))}
          </div>
        </Field>

        <div className="flex gap-3">
          <Field label="Janela início">
            <input type="time" className={inputCls} value={winStart} onChange={(e) => setWinStart(e.target.value)} />
          </Field>
          <Field label="Janela fim">
            <input type="time" className={inputCls} value={winEnd} onChange={(e) => setWinEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Timezone">
          <input className={inputCls} value={tz} onChange={(e) => setTz(e.target.value)} />
        </Field>
        <Field label="Tag Unnichat pós-envio (opcional)">
          <input className={inputCls} value={sentTag} onChange={(e) => setSentTag(e.target.value)} placeholder="uuid da tag" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Ativa
        </label>

        {err && <p className="text-sm text-destructive">{err}</p>}
      </div>
      <ModalFooter onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  );
}

// ─── Template modal ─────────────────────────────────────────────────────────

function TemplateModal({
  initial,
  onClose,
  onSaved,
  onError,
}: {
  initial: Template | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [unnichatId, setUnnichatId] = useState(initial?.unnichat_template_id ?? '');
  const [bodyParams, setBodyParams] = useState<Array<{ type: string; fallback?: string }>>(
    initial?.body_params ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!name.trim()) return setErr('Nome é obrigatório.');
    if (!unnichatId.trim()) return setErr('ID do template Unnichat é obrigatório.');
    const payload = {
      name: name.trim(),
      unnichat_template_id: unnichatId.trim(),
      body_params: bodyParams,
      url_button_params: initial?.url_button_params ?? [],
    };
    setSaving(true);
    try {
      const token = await getAccessToken();
      const res = await edgeFetch(
        initial ? `/v1/recovery/templates/${initial.id}` : '/v1/recovery/templates',
        token,
        { method: initial ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.message ?? 'Falha ao salvar template.');
        return;
      }
      onSaved(initial ? 'Template atualizado.' : 'Template criado.');
    } catch {
      onError('Erro de rede ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Editar template' : 'Novo template'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nome interno">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: abandono_7min" />
        </Field>
        <Field label="ID do template (Unnichat/Meta)">
          <input className={inputCls} value={unnichatId} onChange={(e) => setUnnichatId(e.target.value)} placeholder="ex.: 2186334448831228" />
        </Field>
        <Field label="Placeholders do body">
          <div className="space-y-2">
            {bodyParams.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  className={`${inputCls} w-40`}
                  value={p.type}
                  onChange={(e) =>
                    setBodyParams((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)),
                    )
                  }
                >
                  <option value="contactName">contactName</option>
                  <option value="text">text</option>
                </select>
                <input
                  className={`${inputCls} flex-1`}
                  placeholder="fallback (opcional)"
                  value={p.fallback ?? ''}
                  onChange={(e) =>
                    setBodyParams((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, fallback: e.target.value } : x)),
                    )
                  }
                />
                <button type="button" onClick={() => setBodyParams((prev) => prev.filter((_, j) => j !== i))} className="text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setBodyParams((prev) => [...prev, { type: 'contactName' }])}
              className="text-xs text-primary hover:underline"
            >
              + adicionar placeholder
            </button>
          </div>
        </Field>
        {err && <p className="text-sm text-destructive">{err}</p>}
      </div>
      <ModalFooter onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  );
}

// ─── Shared UI bits ─────────────────────────────────────────────────────────

const inputCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-primary" />
          <h3 className="font-semibold">{title}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({
  onClose,
  onSave,
  saving,
}: {
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-muted-foreground">
        Cancelar
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Salvar
      </button>
    </div>
  );
}
