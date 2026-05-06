'use client';

import { TooltipHelp } from '@/components/tooltip-help';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { cn } from '@/lib/utils';
import { Check, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CredentialsResponse {
  has_sendtok: boolean;
  prefix: string | null;
  length: number | null;
  request_id?: string;
}

interface CampaignMapEntry {
  launch: string;
  stage: string;
  event_name: string;
}

interface WorkspaceConfigResponse {
  config: {
    sendflow?: {
      campaign_map?: Record<string, CampaignMapEntry>;
    };
    [key: string]: unknown;
  };
  request_id?: string;
}

interface Stage {
  slug: string;
  label?: string;
}

interface FunnelBlueprint {
  stages?: Stage[];
  [key: string]: unknown;
}

interface Launch {
  id: string;
  public_id: string;
  name: string;
  status: string;
  config: unknown;
  funnel_blueprint: FunnelBlueprint | null;
  created_at: string;
}

interface LaunchesResponse {
  launches: Launch[];
  request_id?: string;
}

// Editable row keyed by stable client-side row id; campaign_id is editable
// and not safe to use as React key (would dup or remount on edit).
interface EditableRow {
  rowId: string;
  campaign_id: string;
  launch: string;
  stage: string;
  event_name: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WEBHOOK_URL =
  'https://globaltracker-edge.globaltracker.workers.dev/v1/webhooks/sendflow';

// BR-EVENT-001: canonical names + custom: prefix.
const EVENT_NAME_REGEX =
  /^(Contact|Lead|Purchase|InitiateCheckout|AddToCart|ViewContent|CompleteRegistration|custom:.+)$/;

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchWithAuth<T>(path: string): Promise<T> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';
  const res = await edgeFetch(path, token);
  if (!res.ok) {
    throw new Error(`fetch ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function patchWithAuth(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const supabase = createSupabaseBrowser();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token ?? '';
  const res = await edgeFetch(path, token, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

// ─── Sendtok card ─────────────────────────────────────────────────────────────

function SendtokCard({ canEdit }: { canEdit: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<CredentialsResponse>(
    '/v1/integrations/sendflow/credentials',
    fetchWithAuth,
  );

  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: 'idle' }
    | { kind: 'success'; prefix: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const hasToken = data?.has_sendtok === true;

  const tooShort = value.length > 0 && value.length < 16;
  const tooLong = value.length > 200;
  const validClient = value.length >= 16 && value.length <= 200;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!validClient) return;
    setSubmitting(true);
    setFeedback({ kind: 'idle' });
    try {
      const result = await patchWithAuth(
        '/v1/integrations/sendflow/credentials',
        { sendtok: value },
      );
      if (result.ok) {
        const json = result.json as CredentialsResponse | null;
        const prefix = json?.prefix ?? value.slice(0, 4);
        setFeedback({ kind: 'success', prefix });
        setValue('');
        setEditing(false);
        await mutate();
      } else {
        setFeedback({
          kind: 'error',
          message:
            'Não foi possível salvar — verifique o tamanho do token (16 a 200 caracteres).',
        });
      }
    } catch {
      setFeedback({
        kind: 'error',
        message: 'Não foi possível conectar ao servidor.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Token de autenticação (sendtok)
        </CardTitle>
        <CardDescription>
          Header <code className="font-mono text-xs">sendtok</code> validado a
          cada webhook recebido. SendFlow → Configurações → Webhook.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-9 w-full" />}

        {!isLoading && error != null && (
          <p className="text-sm text-red-600" role="alert">
            Não foi possível ler o estado das credenciais.
          </p>
        )}

        {!isLoading && error == null && data != null && (
          <>
            {hasToken && !editing ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Token configurado.
                </p>
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <code
                    className="font-mono text-sm"
                    aria-label={`Token mascarado, prefixo ${data.prefix ?? ''}`}
                  >
                    {data.prefix ?? '????'}
                    <span aria-hidden="true">••••••••••</span>
                  </code>
                  <span className="text-xs text-muted-foreground">
                    ({data.length ?? 0} chars)
                  </span>
                </div>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(true);
                      setFeedback({ kind: 'idle' });
                    }}
                  >
                    Substituir
                  </Button>
                )}
              </div>
            ) : (
              <>
                {!hasToken && (
                  <p className="text-sm text-muted-foreground">
                    Não configurado. Cadastre o token gerado no SendFlow.
                  </p>
                )}
                {canEdit ? (
                  <form
                    className="space-y-3"
                    onSubmit={(e) => void handleSave(e)}
                  >
                    <div className="space-y-1">
                      <label
                        htmlFor="sendflow-sendtok"
                        className="text-sm font-medium"
                      >
                        Sendtok
                      </label>
                      <input
                        id="sendflow-sendtok"
                        type="password"
                        autoComplete="off"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        aria-invalid={tooShort || tooLong}
                        aria-describedby="sendflow-sendtok-hint"
                        className={cn(
                          'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm font-mono',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          (tooShort || tooLong) && 'border-destructive',
                        )}
                      />
                      <p
                        id="sendflow-sendtok-hint"
                        className="text-xs text-muted-foreground"
                      >
                        Mínimo 16, máximo 200 caracteres.
                        {tooShort && (
                          <span className="text-destructive">
                            {' '}
                            Faltam {16 - value.length} caracteres.
                          </span>
                        )}
                        {tooLong && (
                          <span className="text-destructive">
                            {' '}
                            Acima do limite.
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!validClient || submitting}
                      >
                        {submitting && (
                          <Loader2
                            className="h-4 w-4 mr-1.5 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        Salvar
                      </Button>
                      {editing && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(false);
                            setValue('');
                            setFeedback({ kind: 'idle' });
                          }}
                          disabled={submitting}
                        >
                          Cancelar
                        </Button>
                      )}
                    </div>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Você não tem permissão para editar credenciais. Contate um
                    operador ou administrador.
                  </p>
                )}
              </>
            )}

            <div aria-live="polite" className="min-h-[1rem]">
              {feedback.kind === 'success' && (
                <output className="text-sm text-green-600 block">
                  Token salvo. Prefixo:{' '}
                  <code className="font-mono">{feedback.prefix}</code>.
                </output>
              )}
            </div>
            {feedback.kind === 'error' && (
              <p className="text-sm text-red-600" role="alert">
                {feedback.message}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Campaign map card ────────────────────────────────────────────────────────

function CampaignMapCard({ canEdit }: { canEdit: boolean }) {
  const {
    data: configData,
    error: configError,
    isLoading: configLoading,
    mutate: mutateConfig,
  } = useSWR<WorkspaceConfigResponse>('/v1/workspace/config', fetchWithAuth);

  const {
    data: launchesData,
    error: launchesError,
    isLoading: launchesLoading,
  } = useSWR<LaunchesResponse>('/v1/launches', fetchWithAuth);

  const [rows, setRows] = useState<EditableRow[]>([]);
  const [snapshot, setSnapshot] = useState<EditableRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: 'idle' }
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // Hydrate state when config loads.
  useEffect(() => {
    const map = configData?.config?.sendflow?.campaign_map ?? {};
    const next: EditableRow[] = Object.entries(map).map(
      ([campaignId, entry], idx) => ({
        rowId: `existing-${idx}-${campaignId}`,
        campaign_id: campaignId,
        launch: entry.launch,
        stage: entry.stage,
        event_name: entry.event_name,
      }),
    );
    setRows(next);
    setSnapshot(next);
  }, [configData]);

  const launches: Launch[] = useMemo(
    () => launchesData?.launches ?? [],
    [launchesData],
  );

  // Build a map for stage lookup by launch.public_id.
  const stagesByLaunch: Record<string, Stage[]> = useMemo(() => {
    const out: Record<string, Stage[]> = {};
    for (const launch of launches) {
      out[launch.public_id] = launch.funnel_blueprint?.stages ?? [];
    }
    return out;
  }, [launches]);

  const isDirty = useMemo(
    () =>
      JSON.stringify(rowsToCompare(rows)) !==
      JSON.stringify(rowsToCompare(snapshot)),
    [rows, snapshot],
  );

  // Validation of the whole rows set.
  const validation = useMemo(() => validateRows(rows), [rows]);

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        campaign_id: '',
        launch: '',
        stage: '',
        event_name: '',
      },
    ]);
  }

  function removeRow(rowId: string) {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  }

  function updateRow(rowId: string, patch: Partial<EditableRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        const next = { ...r, ...patch };
        // If launch changed, reset stage (different funnel_blueprint).
        if (patch.launch != null && patch.launch !== r.launch) {
          next.stage = '';
        }
        return next;
      }),
    );
  }

  // Detect rows present in snapshot but missing now → tombstone via null in PATCH.
  const removedCampaignIds = useMemo(() => {
    const current = new Set(rows.map((r) => r.campaign_id).filter(Boolean));
    const removed: string[] = [];
    for (const s of snapshot) {
      if (s.campaign_id && !current.has(s.campaign_id)) {
        removed.push(s.campaign_id);
      }
    }
    return removed;
  }, [rows, snapshot]);

  async function handleSave() {
    if (!validation.ok) return;
    setSubmitting(true);
    setFeedback({ kind: 'idle' });
    try {
      // Map novo: chaves atuais → entries; chaves removidas → null (tombstone, T-13-016d).
      const campaignMap: Record<string, CampaignMapEntry | null> = {};
      for (const r of rows) {
        campaignMap[r.campaign_id.trim()] = {
          launch: r.launch,
          stage: r.stage,
          event_name: r.event_name.trim(),
        };
      }
      for (const id of removedCampaignIds) {
        campaignMap[id] = null;
      }
      const result = await patchWithAuth('/v1/workspace/config', {
        sendflow: { campaign_map: campaignMap },
      });
      if (result.ok) {
        await mutateConfig();
        const removedNote =
          removedCampaignIds.length > 0
            ? ` ${removedCampaignIds.length} mapeamento${removedCampaignIds.length > 1 ? 's removidos' : ' removido'}.`
            : '';
        setFeedback({
          kind: 'success',
          message: `Mapeamentos salvos.${removedNote}`,
        });
      } else {
        const json = result.json as { message?: string } | null;
        setFeedback({
          kind: 'error',
          message: json?.message ?? 'Não foi possível salvar os mapeamentos.',
        });
      }
    } catch {
      setFeedback({
        kind: 'error',
        message: 'Não foi possível conectar ao servidor.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Mapeamento de campanhas → stages
        </CardTitle>
        <CardDescription>
          Cada <code className="font-mono text-xs">campaignId</code> do SendFlow
          é mapeado para um launch + stage + event_name.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(configLoading || launchesLoading) && (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {(configError != null || launchesError != null) &&
          !configLoading &&
          !launchesLoading && (
            <p className="text-sm text-red-600" role="alert">
              Não foi possível carregar a configuração ou os lançamentos.
            </p>
          )}

        {!configLoading &&
          !launchesLoading &&
          configError == null &&
          launchesError == null && (
            <>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nenhum mapeamento configurado. Adicione uma linha para
                  começar.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-separate border-spacing-y-2">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th scope="col" className="font-medium pr-2">
                          <span className="inline-flex items-center gap-1">
                            Campaign ID
                            <TooltipHelp content="ID da campanha no SendFlow (Configurações → Webhook). Geralmente uma string aleatória, ex.: 0b4IxLZFiYOxxRyO6ZmE." />
                          </span>
                        </th>
                        <th scope="col" className="font-medium pr-2">
                          Launch
                        </th>
                        <th scope="col" className="font-medium pr-2">
                          Stage
                        </th>
                        <th scope="col" className="font-medium pr-2">
                          <span className="inline-flex items-center gap-1">
                            Event name
                            <TooltipHelp content="Nomes canônicos (Contact, Lead, Purchase, InitiateCheckout, AddToCart, ViewContent, CompleteRegistration) ou prefixo custom: (BR-EVENT-001)." />
                          </span>
                        </th>
                        <th scope="col" className="sr-only">
                          Ações
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const stages = row.launch
                          ? (stagesByLaunch[row.launch] ?? [])
                          : [];
                        const rowError = validation.errorsByRow[row.rowId];
                        return (
                          <tr key={row.rowId} className="align-top">
                            <td className="pr-2">
                              <input
                                type="text"
                                value={row.campaign_id}
                                onChange={(e) =>
                                  updateRow(row.rowId, {
                                    campaign_id: e.target.value,
                                  })
                                }
                                placeholder="0b4IxLZFiYOxxRyO6ZmE"
                                aria-label="Campaign ID do SendFlow"
                                disabled={!canEdit}
                                className={cn(
                                  'flex h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm font-mono',
                                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  rowError?.field === 'campaign_id' &&
                                    'border-destructive',
                                )}
                              />
                            </td>
                            <td className="pr-2">
                              <select
                                value={row.launch}
                                onChange={(e) =>
                                  updateRow(row.rowId, {
                                    launch: e.target.value,
                                  })
                                }
                                aria-label="Launch"
                                disabled={!canEdit}
                                className={cn(
                                  'flex h-9 w-48 rounded-md border border-input bg-background px-2 py-1 text-sm',
                                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  rowError?.field === 'launch' &&
                                    'border-destructive',
                                )}
                              >
                                <option value="" disabled>
                                  Selecione…
                                </option>
                                {launches.map((l) => (
                                  <option key={l.public_id} value={l.public_id}>
                                    {l.name} ({l.public_id})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="pr-2">
                              <select
                                value={row.stage}
                                onChange={(e) =>
                                  updateRow(row.rowId, {
                                    stage: e.target.value,
                                  })
                                }
                                aria-label="Stage"
                                disabled={!canEdit || !row.launch}
                                className={cn(
                                  'flex h-9 w-48 rounded-md border border-input bg-background px-2 py-1 text-sm',
                                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  rowError?.field === 'stage' &&
                                    'border-destructive',
                                  (!row.launch || !canEdit) &&
                                    'opacity-60 cursor-not-allowed',
                                )}
                              >
                                <option value="" disabled>
                                  {row.launch
                                    ? 'Selecione…'
                                    : 'Escolha o launch'}
                                </option>
                                {stages.map((s) => (
                                  <option key={s.slug} value={s.slug}>
                                    {s.label ?? s.slug}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="pr-2">
                              <input
                                type="text"
                                value={row.event_name}
                                onChange={(e) =>
                                  updateRow(row.rowId, {
                                    event_name: e.target.value,
                                  })
                                }
                                placeholder="Contact ou custom:wpp_joined_vip_main"
                                aria-label="Event name"
                                disabled={!canEdit}
                                className={cn(
                                  'flex h-9 w-56 rounded-md border border-input bg-background px-3 py-1 text-sm',
                                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                  rowError?.field === 'event_name' &&
                                    'border-destructive',
                                )}
                              />
                            </td>
                            <td>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => removeRow(row.rowId)}
                                disabled={!canEdit}
                                aria-label={`Remover mapeamento ${row.campaign_id || '(sem id)'}`}
                              >
                                <Trash2
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {validation.errors.length > 0 && (
                <ul
                  className="text-xs text-destructive space-y-0.5"
                  role="alert"
                >
                  {validation.errors.map((err) => (
                    <li key={err}>• {err}</li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={addRow}
                  disabled={!canEdit}
                >
                  <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  Adicionar mapeamento
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={
                    !canEdit || !isDirty || !validation.ok || submitting
                  }
                >
                  {submitting && (
                    <Loader2
                      className="h-4 w-4 mr-1.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  Salvar mapeamentos
                </Button>
                {!canEdit && (
                  <span className="text-xs text-muted-foreground">
                    Somente leitura — peça a um operador para editar.
                  </span>
                )}
              </div>

              <div aria-live="polite" className="min-h-[1rem]">
                {feedback.kind === 'success' && (
                  <output className="text-sm text-green-600 block">
                    {feedback.message}
                  </output>
                )}
              </div>
              {feedback.kind === 'error' && (
                <p className="text-sm text-red-600" role="alert">
                  {feedback.message}
                </p>
              )}
            </>
          )}
      </CardContent>
    </Card>
  );
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function rowsToCompare(rows: EditableRow[]): unknown[] {
  // Stable comparison ignoring rowId (which is client-local).
  return rows
    .map((r) => ({
      campaign_id: r.campaign_id.trim(),
      launch: r.launch,
      stage: r.stage,
      event_name: r.event_name.trim(),
    }))
    .sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
}

function validateRows(rows: EditableRow[]): {
  ok: boolean;
  errors: string[];
  errorsByRow: Record<string, { field: keyof EditableRow }>;
} {
  const errors: string[] = [];
  const errorsByRow: Record<string, { field: keyof EditableRow }> = {};
  const seen = new Set<string>();

  for (const row of rows) {
    const cid = row.campaign_id.trim();
    if (!cid) {
      errors.push('Existe um mapeamento sem Campaign ID.');
      errorsByRow[row.rowId] = { field: 'campaign_id' };
      continue;
    }
    if (seen.has(cid)) {
      errors.push(`Campaign ID duplicado: "${cid}".`);
      errorsByRow[row.rowId] = { field: 'campaign_id' };
      continue;
    }
    seen.add(cid);

    if (!row.launch) {
      errors.push(`"${cid}": selecione um launch.`);
      errorsByRow[row.rowId] = { field: 'launch' };
      continue;
    }
    if (!row.stage) {
      errors.push(`"${cid}": selecione um stage.`);
      errorsByRow[row.rowId] = { field: 'stage' };
      continue;
    }
    const evt = row.event_name.trim();
    if (!evt) {
      errors.push(`"${cid}": informe um event_name.`);
      errorsByRow[row.rowId] = { field: 'event_name' };
      continue;
    }
    if (!EVENT_NAME_REGEX.test(evt)) {
      errors.push(
        `"${cid}": event_name "${evt}" inválido — use canônico ou prefixo custom:.`,
      );
      errorsByRow[row.rowId] = { field: 'event_name' };
    }
  }

  return { ok: errors.length === 0, errors, errorsByRow };
}

// ─── Webhook info card ────────────────────────────────────────────────────────

function WebhookInfoCard() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Best-effort — fail silently if clipboard unavailable (e.g. insecure context).
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Como receber webhooks</CardTitle>
        <CardDescription>
          Configure no SendFlow → Configurações → Webhook.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            URL do webhook
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono break-all">
              {WEBHOOK_URL}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleCopy()}
              aria-label="Copiar URL do webhook"
            >
              {copied ? (
                <>
                  <Check
                    className="h-4 w-4 mr-1.5 text-green-600"
                    aria-hidden="true"
                  />
                  Copiado
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  Copiar
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            Header de autenticação
          </p>
          <code className="block rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono">
            sendtok: &lt;seu token&gt;
          </code>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            Eventos suportados
          </p>
          <ul className="text-sm space-y-0.5">
            <li>
              <code className="font-mono text-xs">
                group.updated.members.added
              </code>
            </li>
            <li>
              <code className="font-mono text-xs">
                group.updated.members.removed
              </code>
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Top-level export ─────────────────────────────────────────────────────────

interface SendflowDetailClientProps {
  canEdit: boolean;
}

export function SendflowDetailClient({ canEdit }: SendflowDetailClientProps) {
  return (
    <div className="space-y-4">
      <SendtokCard canEdit={canEdit} />
      <CampaignMapCard canEdit={canEdit} />
      <WebhookInfoCard />
    </div>
  );
}
