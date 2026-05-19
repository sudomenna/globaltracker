/**
 * LeadSummaryHeader — Client Component (T-17-010 + T-TAGS-007)
 *
 * Renderiza o painel agregado, PII-free, do lead: jornada de stages, tags,
 * atribuição (first/last touch + click ids), consentimento atual e métricas.
 *
 * Fonte do shape: /v1/leads/:public_id/summary (apps/edge/src/lib/lead-summary.ts).
 *
 * BR-PRIVACY-001: este componente NUNCA renderiza email/phone/name — só
 * agregados e UTMs. PII fica acima, no header de identificação.
 * BR-RBAC: gating de "Identidade" é responsabilidade do page.tsx — aqui não há
 * informação sensível por papel.
 *
 * T-TAGS-007: o TagsPanel passou a ter CRUD manual (apply/remove tags) +
 * optimistic update + rollback. A conversão de server-component para
 * client-component foi feita para alojar o estado interativo; os dados
 * iniciais continuam vindo do server (page.tsx) e são serializáveis (JSON).
 */

'use client';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tooltip } from '@/components/ui/tooltip';
import { TagChip } from '@/components/tags/TagChip';
import { TagPicker } from '@/components/tags/TagPicker';
import {
  useWorkspaceTags,
  type WorkspaceTag,
} from '@/components/tags/use-workspace-tags';
import {
  Activity,
  Clock,
  Coins,
  Loader2,
  Plus,
  Send,
  Shield,
  Tag,
  X,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LeadSummary } from './lead-summary-types';

interface LeadSummaryHeaderProps {
  summary: LeadSummary;
  role: string;
  /**
   * T-TAGS-007: necessário para as chamadas /v1/leads-tags/by-lead/:id (add/remove).
   * Equivale a leads.id (BR-IDENTITY-013). Quando omitido, fazemos fallback
   * para `usePathname()` — evita alterar a assinatura externa consumida pelo
   * page.tsx (server component, fora do ownership desta T-ID).
   */
  leadPublicId?: string;
}

const EDGE = process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTimePtBR(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatRelativePtBR(iso: string): string {
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffSec = Math.round((then - now) / 1000);
    const abs = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
    if (abs < 60) return rtf.format(diffSec, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86400), 'day');
    if (abs < 31_536_000)
      return rtf.format(Math.round(diffSec / 2_592_000), 'month');
    return rtf.format(Math.round(diffSec / 31_536_000), 'year');
  } catch {
    return iso;
  }
}

function formatBrl(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

/**
 * Lê access_token do cookie sb-*-auth-token. Replicado de outros locais (page
 * contatos, use-workspace-tags) — sem dependência ao app/(app)/contatos/page.tsx.
 */
function readAccessTokenFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
  if (!match) return '';
  try {
    let raw = match[1];
    if (raw?.startsWith('base64-')) {
      raw = atob(raw.slice(7));
    } else if (raw) {
      raw = decodeURIComponent(raw);
    }
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed?.access_token ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// JourneyStrip
// ---------------------------------------------------------------------------

function JourneyStrip({
  stages,
  current,
}: {
  stages: LeadSummary['stages_journey'];
  current: LeadSummary['current_stage'];
}) {
  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Sem stages registrados</p>
    );
  }

  const currentSince = current?.since ?? null;

  return (
    <nav aria-label="Jornada do lead" className="overflow-x-auto">
      <ol className="flex items-center gap-2 flex-wrap">
        {stages.map((s, idx) => {
          const isCurrent = currentSince
            ? s.at === currentSince && idx === stages.length - 1
            : idx === stages.length - 1;
          const isLast = idx === stages.length - 1;
          return (
            <li key={`${s.stage}-${s.at}`} className="flex items-center gap-2">
              <div
                className={
                  isCurrent
                    ? 'inline-flex flex-col items-start rounded-md border-2 border-primary bg-primary/10 px-2.5 py-1'
                    : 'inline-flex flex-col items-start rounded-md bg-muted px-2.5 py-1'
                }
              >
                <span
                  className={
                    isCurrent
                      ? 'text-xs font-semibold text-primary'
                      : 'text-xs font-medium text-foreground'
                  }
                >
                  {s.stage}
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatDateTimePtBR(s.at)}
                </span>
              </div>
              {!isLast && (
                <span className="text-muted-foreground" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// TagsPanel — T-TAGS-007: CRUD manual (apply/remove) + optimistic update
// ---------------------------------------------------------------------------

type LeadTag = LeadSummary['tags'][number];

function TagsPanel({
  initialTags,
  leadPublicId,
}: {
  initialTags: LeadSummary['tags'];
  leadPublicId: string;
}) {
  const router = useRouter();
  // Optimistic local state — espelha `summary.tags`. Quando server-data muda
  // (refresh), o `useEffect` abaixo re-sincroniza.
  const [tags, setTags] = useState<LeadTag[]>(initialTags);
  const [picking, setPicking] = useState(false);
  const [pickerSelection, setPickerSelection] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // O catálogo do workspace alimenta cores no TagChip e o autocomplete do picker.
  const { tags: catalog } = useWorkspaceTags();

  // Re-sync quando o server-component re-renderiza com novos tags (após
  // router.refresh()). Comparação rasa por chave nome+set_at evita
  // sobrescrever uma transição otimista enquanto a request está in-flight.
  useEffect(() => {
    if (pending) return;
    setTags(initialTags);
  }, [initialTags, pending]);

  // Fechar popover ao clicar fora.
  useEffect(() => {
    if (!picking) return;
    function onDocDown(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) {
        setPicking(false);
        setPickerSelection([]);
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [picking]);

  const colorFor = useCallback(
    (name: string): string | null => {
      const t = catalog.find(
        (c: WorkspaceTag) => c.name.toLowerCase() === name.toLowerCase(),
      );
      return t?.color ?? null;
    },
    [catalog],
  );

  // Opções para o picker — exclui as já aplicadas (case-insensitive).
  const availableForPicker = useMemo(() => {
    const applied = new Set(tags.map((t) => t.tag_name.toLowerCase()));
    return catalog
      .filter((c) => !c.archived_at && !applied.has(c.name.toLowerCase()))
      .map((c) => ({ id: c.id, name: c.name, color: c.color }));
  }, [catalog, tags]);

  async function removeTag(tagName: string) {
    if (pending) return;
    if (!leadPublicId) {
      setError('Não foi possível identificar o lead');
      return;
    }
    setError(null);
    const previous = tags;
    // Optimistic remove
    setTags((prev) => prev.filter((t) => t.tag_name !== tagName));
    setPending(true);
    try {
      const token = readAccessTokenFromCookie();
      if (!token) throw new Error('Sessão expirada');
      const res = await fetch(
        `${EDGE}/v1/leads-tags/by-lead/${encodeURIComponent(
          leadPublicId,
        )}/${encodeURIComponent(tagName)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        // Rollback
        setTags(previous);
        setError(`Falha ao remover tag (HTTP ${res.status})`);
        return;
      }
      // Sucesso — buscar dados frescos do server (atualiza set_by/set_at canônicos).
      router.refresh();
    } catch (e) {
      setTags(previous);
      setError(e instanceof Error ? e.message : 'Falha ao remover tag');
    } finally {
      setPending(false);
    }
  }

  async function submitAddTags() {
    if (pending) return;
    if (!leadPublicId) {
      setError('Não foi possível identificar o lead');
      return;
    }
    const names = pickerSelection
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) {
      setPicking(false);
      return;
    }
    setError(null);
    const previous = tags;
    // Optimistic add — `set_by` e `set_at` ficam com placeholder até refresh
    // do server (rótulos no tooltip são best-effort enquanto pending).
    const nowIso = new Date().toISOString();
    const additions: LeadTag[] = names
      .filter(
        (n) =>
          !tags.some(
            (t) => t.tag_name.toLowerCase() === n.toLowerCase(),
          ),
      )
      .map((n) => ({ tag_name: n, set_by: 'user:você', set_at: nowIso }));
    setTags((prev) => [...prev, ...additions]);
    setPending(true);
    try {
      const token = readAccessTokenFromCookie();
      if (!token) throw new Error('Sessão expirada');
      const res = await fetch(
        `${EDGE}/v1/leads-tags/by-lead/${encodeURIComponent(leadPublicId)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ tag_names: names }),
        },
      );
      if (!res.ok) {
        setTags(previous);
        setError(`Falha ao aplicar tags (HTTP ${res.status})`);
        return;
      }
      setPicking(false);
      setPickerSelection([]);
      router.refresh();
    } catch (e) {
      setTags(previous);
      setError(e instanceof Error ? e.message : 'Falha ao aplicar tags');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <section aria-label="Tags do lead">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Tag className="h-4 w-4" aria-hidden="true" />
            Tags
            {pending && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.length === 0 && !picking && (
              <p className="text-sm text-muted-foreground mr-2">
                Sem tags atribuídas
              </p>
            )}
            {tags.map((t) => (
              <Tooltip
                key={`${t.tag_name}-${t.set_at}`}
                content={`Definida por: ${t.set_by} • ${formatDateTimePtBR(t.set_at)}`}
              >
                <TagChip
                  name={t.tag_name}
                  color={colorFor(t.tag_name)}
                  removable
                  onRemove={() => void removeTag(t.tag_name)}
                />
              </Tooltip>
            ))}

            {/* Trigger "+ Adicionar tag" */}
            {!picking && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPickerSelection([]);
                  setPicking(true);
                }}
                disabled={pending}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-input px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                aria-label="Adicionar tag"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Adicionar tag
              </button>
            )}
          </div>

          {/* Picker popover (inline; o root tem position relative no pai
              via popoverRef). Decisão UX: usar bloco inline em vez de modal
              porque o usuário precisa ver os chips existentes ao adicionar. */}
          {picking && (
            <div
              ref={popoverRef}
              className="mt-3 space-y-2 rounded-md border border-input bg-background p-3"
            >
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Adicionar tags
              </div>
              <TagPicker
                availableTags={availableForPicker}
                selectedNames={pickerSelection}
                onChange={setPickerSelection}
                allowCreate
                placeholder="Buscar ou criar tag..."
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPicking(false);
                    setPickerSelection([]);
                  }}
                  disabled={pending}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void submitAddTags()}
                  disabled={pending || pickerSelection.length === 0}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {pending ? (
                    <Loader2
                      className="h-3 w-3 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Plus className="h-3 w-3" aria-hidden="true" />
                  )}
                  Aplicar
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ConsentPanel
// ---------------------------------------------------------------------------

const CONSENT_LABELS: Array<{
  key: keyof NonNullable<LeadSummary['consent_current']>;
  label: string;
}> = [
  { key: 'analytics', label: 'Analytics' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'ad_user_data', label: 'Ad user data' },
  { key: 'ad_personalization', label: 'Ad personalization' },
  { key: 'customer_match', label: 'Customer match' },
];

function ConsentPanel({
  consent,
}: {
  consent: LeadSummary['consent_current'];
}) {
  return (
    <Card>
      <section aria-label="Consentimento do lead">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Shield className="h-4 w-4" aria-hidden="true" />
            Consentimento
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          {!consent ? (
            <p className="text-sm text-muted-foreground">
              Sem consentimento registrado
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {CONSENT_LABELS.map(({ key, label }) => {
                  const value = consent[key] as boolean;
                  return (
                    <Badge
                      key={key}
                      variant={value ? 'success' : 'outline'}
                      aria-label={`${label}: ${value ? 'concedido' : 'negado'}`}
                    >
                      {label}
                    </Badge>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Atualizado em {formatDateTimePtBR(consent.updated_at)}
              </p>
            </>
          )}
        </CardContent>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MetricsPanel
// ---------------------------------------------------------------------------

function dispatchesBadgeVariant(
  ok: number,
  failed: number,
  skipped: number,
): 'success' | 'warning' | 'destructive' | 'outline' {
  const total = ok + failed + skipped;
  if (total === 0) return 'outline';
  if (failed > 0) return 'destructive';
  if (skipped > 0) return 'warning';
  return 'success';
}

function MetricsPanel({ metrics }: { metrics: LeadSummary['metrics'] }) {
  const totalDispatches =
    metrics.dispatches_ok + metrics.dispatches_failed + metrics.dispatches_skipped;
  const dispatchVariant = dispatchesBadgeVariant(
    metrics.dispatches_ok,
    metrics.dispatches_failed,
    metrics.dispatches_skipped,
  );
  const dispatchVariantClass: Record<
    typeof dispatchVariant,
    string
  > = {
    success: 'text-green-700',
    warning: 'text-yellow-700',
    destructive: 'text-red-700',
    outline: 'text-foreground',
  };

  return (
    <section
      aria-label="Métricas do lead"
      className="grid grid-cols-2 md:grid-cols-4 gap-2"
    >
      {/* Eventos */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            Eventos
          </div>
          <p className="text-xl font-semibold mt-0.5">
            {metrics.events_total.toLocaleString('pt-BR')}
          </p>
        </CardContent>
      </Card>

      {/* Despachos */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Despachos
          </div>
          <p
            className={`text-xl font-semibold mt-0.5 ${dispatchVariantClass[dispatchVariant]}`}
          >
            {metrics.dispatches_ok}/{totalDispatches} OK
          </p>
        </CardContent>
      </Card>

      {/* Comprado */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Coins className="h-3.5 w-3.5" aria-hidden="true" />
            Comprado
          </div>
          <p className="text-xl font-semibold mt-0.5">
            {formatBrl(metrics.purchase_total_brl)}
          </p>
        </CardContent>
      </Card>

      {/* Última atividade */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Última atividade
          </div>
          {metrics.last_activity_at ? (
            <Tooltip content={formatDateTimePtBR(metrics.last_activity_at)}>
              <p className="text-sm font-medium mt-0.5">
                {formatRelativePtBR(metrics.last_activity_at)}
              </p>
            </Tooltip>
          ) : (
            <p className="text-sm text-muted-foreground mt-0.5">—</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main composition
// ---------------------------------------------------------------------------

// `/contatos/<uuid>` ou `/contatos/<uuid>/qualquer-coisa` → captura o uuid.
const LEAD_PUBLIC_ID_PATH_RE =
  /\/contatos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function LeadSummaryHeader({
  summary,
  role: _role,
  leadPublicId,
}: LeadSummaryHeaderProps) {
  const pathname = usePathname();
  // Fallback para deriver leadPublicId da URL — mantém o page.tsx (server,
  // fora do ownership) sem mudanças necessárias.
  const resolvedLeadId =
    leadPublicId ?? pathname?.match(LEAD_PUBLIC_ID_PATH_RE)?.[1] ?? '';

  return (
    <div className="space-y-3">
      {/* Linha 1 — JourneyStrip ocupa toda a largura */}
      <Card>
        <section aria-label="Jornada do lead (linha do tempo de stages)">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm font-semibold">Jornada</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <JourneyStrip
              stages={summary.stages_journey}
              current={summary.current_stage}
            />
          </CardContent>
        </section>
      </Card>

      {/* Linha 2 — Métricas (sempre full-width grid) */}
      <MetricsPanel metrics={summary.metrics} />

      {/* Linha 3 — grid 2 colunas (desktop) com Tags | Consent */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TagsPanel initialTags={summary.tags} leadPublicId={resolvedLeadId} />
        <ConsentPanel consent={summary.consent_current} />
      </div>
    </div>
  );
}
