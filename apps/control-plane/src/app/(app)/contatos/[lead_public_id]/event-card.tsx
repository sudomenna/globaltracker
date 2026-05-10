'use client';

/**
 * event-card.tsx — bloco de evento na aba Jornada.
 *
 * Onda 4 (Sprint 17): T-17-013.
 *
 * Renderiza um event_captured com seus dispatches correlacionados e tags
 * inline. Suporta expand/collapse com payload completo, atribuição completa
 * e detalhes de dispatch (gated por role para PII — BR-PRIVACY-001 / BR-RBAC).
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, HelpCircle, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import {
  MoneyValue,
  OriginBadge,
  PageInline,
  TagBadge,
} from './journey-helpers';
import { RedispatchDialog } from './redispatch-dialog';
import { WhyFailedSheet } from './why-failed-sheet';

// Mirror of TimelineNode shape from leads-timeline.ts (kept local to evitar
// dependência de import server-side; o client recebe via JSON).
export interface TimelineNode {
  id: string;
  type:
    | 'event_captured'
    | 'dispatch_queued'
    | 'dispatch_success'
    | 'dispatch_failed'
    | 'dispatch_skipped'
    | 'attribution_set'
    | 'stage_changed'
    | 'merge'
    | 'consent_updated'
    | 'tag_added';
  occurred_at: string;
  status: 'ok' | 'failed' | 'skipped' | 'pending';
  label?: string;
  detail?: string;
  destination?: string;
  job_id?: string;
  payload: Record<string, unknown>;
  skip_reason: string | null;
  can_replay: boolean;
}

export interface OrderBumpSummary {
  key: string;
  productName: string;
  amount?: number;
  currency?: string;
}

interface EventCardProps {
  event: TimelineNode;
  dispatches: TimelineNode[];
  tags: TimelineNode[];
  /** stage_changed correlacionado (opcional) — exibido inline no body */
  stageChange?: TimelineNode | null;
  role: string;
  /** Order bumps do mesmo checkout OnProfit — exibidos dentro do card */
  orderBumps?: OrderBumpSummary[];
}

const DESTINATION_LABEL: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  ga4_mp: 'GA4 MP',
  google_ads_conversion: 'Google Ads',
  google_enhancement: 'Google (Enhanced)',
  audience_sync: 'Audience Sync',
};

function dispatchStatusVariant(
  status: TimelineNode['status'],
): 'success' | 'destructive' | 'warning' | 'secondary' {
  switch (status) {
    case 'ok':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'skipped':
      return 'warning';
    default:
      return 'secondary';
  }
}

function dispatchStatusLabel(status: TimelineNode['status']): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'failed':
      return 'FAIL';
    case 'skipped':
      return 'SKIP';
    default:
      return 'PEND';
  }
}

function eventBorderClass(status: TimelineNode['status']): string {
  switch (status) {
    case 'ok':
      return 'border-l-green-500';
    case 'failed':
      return 'border-l-red-500';
    case 'skipped':
      return 'border-l-yellow-500';
    default:
      return 'border-l-gray-300';
  }
}

function formatLatency(ms: unknown): string | null {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return null;
  return `${Math.round(n)}ms`;
}

function truncate(s: string, max = 12): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function EventCard({
  event,
  dispatches,
  tags,
  stageChange,
  role,
  orderBumps,
}: EventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [whySheetOpen, setWhySheetOpen] = useState(false);
  const [whyReason, setWhyReason] = useState<string | null>(null);
  const [redispatchOpen, setRedispatchOpen] = useState(false);
  const [redispatchJobId, setRedispatchJobId] = useState<string | null>(null);

  const detailsId = useId();
  const titleId = useId();

  const canRedispatch = role === 'operator' || role === 'admin';
  const canSeePii = role === 'operator' || role === 'admin';

  const eventName = (event.payload.event_name as string | undefined) ?? 'evento';
  const eventSource = event.payload.event_source as string | null | undefined;
  const pageName = event.payload.page_name as string | null | undefined;
  const launchName = event.payload.launch_name as string | null | undefined;
  const customData = event.payload.custom_data;
  const attributionSnapshot = event.payload.attribution_snapshot;
  const processingStatus =
    (event.payload.processing_status as string | null | undefined) ?? null;

  const value = isRecord(customData) ? customData.value : undefined;
  const currency =
    (isRecord(customData) ? (customData.currency as string | undefined) : undefined) ??
    null;

  const ts = new Date(event.occurred_at).toLocaleString('pt-BR');

  function handleWhyFailed(reason: string) {
    setWhyReason(reason);
    setWhySheetOpen(true);
  }

  function handleRedispatch(jobId: string) {
    setRedispatchJobId(jobId);
    setRedispatchOpen(true);
  }

  // UTM line — compact format
  const utmEntries = isRecord(attributionSnapshot)
    ? Object.entries(attributionSnapshot).filter(([k]) => k.startsWith('utm_'))
    : [];
  const clickIds = isRecord(attributionSnapshot)
    ? Object.entries(attributionSnapshot).filter(([k]) =>
        ['fbclid', 'gclid'].includes(k),
      )
    : [];

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        'transition-shadow',
        // espaço vertical 12px entre cards
        'mb-3',
      )}
    >
      <Card className={cn('border-l-4', eventBorderClass(event.status))}>
        {/* Header — sempre visível */}
        <div className="p-4 space-y-1.5">
          {/* Linha 1: origin + nome + valor */}
          <div className="flex items-center gap-2 flex-wrap">
            <OriginBadge source={eventSource ?? null} />
            <span id={titleId} className="font-medium text-sm">
              {eventName}
            </span>
            {value !== undefined && value !== null && (
              <MoneyValue value={value} currency={currency} />
            )}
            {tags.map((t) => {
              const name = (t.payload.tag_name as string | undefined) ?? '';
              return name ? <TagBadge key={t.id} name={name} /> : null;
            })}
          </div>

          {/* Linha 2: page + launch + timestamp */}
          <div className="flex items-center gap-2 flex-wrap">
            <PageInline pageName={pageName} launchName={launchName} />
            <span className="text-xs text-muted-foreground">· {ts}</span>
          </div>

          {/* Linha 3: UTM line (condicional) */}
          {(utmEntries.length > 0 || clickIds.length > 0) && (
            <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
              {utmEntries.length > 0 && (
                <span aria-label="Atribuição">
                  📍{' '}
                  {utmEntries
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(' · ')}
                </span>
              )}
              {clickIds.map(([k, v]) => (
                <Badge key={k} variant="outline" className="text-[10px]">
                  {k}: {truncate(String(v))}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Body collapsado — sempre visível */}
        <div className="border-t px-4 py-3 space-y-1.5 bg-muted/20">
          {dispatches.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              Nenhum despacho registrado para este evento.
            </p>
          )}
          {dispatches.map((d) => {
            const destLabel =
              DESTINATION_LABEL[d.destination ?? ''] ??
              d.destination ??
              'desconhecido';
            const responseCode = d.payload.response_code as number | null | undefined;
            const latency = formatLatency(d.payload.latency_ms);
            const showWhy = d.status === 'failed' || d.status === 'skipped';
            return (
              <div
                key={d.id}
                className="flex items-center gap-2 text-xs flex-wrap"
              >
                <Badge variant={dispatchStatusVariant(d.status)} className="text-[10px]">
                  {dispatchStatusLabel(d.status)}
                </Badge>
                <span className="font-medium">{destLabel}</span>
                {responseCode != null && (
                  <span className="text-muted-foreground">· {responseCode}</span>
                )}
                {latency && (
                  <span className="text-muted-foreground">· {latency}</span>
                )}
                {d.skip_reason && (
                  <span className="text-muted-foreground italic">
                    · {d.skip_reason}
                  </span>
                )}
                {showWhy && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() =>
                      handleWhyFailed(d.skip_reason ?? d.type)
                    }
                    aria-label="Por que falhou?"
                  >
                    <HelpCircle className="h-3 w-3 mr-0.5" />
                    Por quê?
                  </Button>
                )}
                {d.can_replay && canRedispatch && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10px]"
                    onClick={() => handleRedispatch(d.id)}
                    aria-label="Re-disparar"
                  >
                    <RefreshCw className="h-3 w-3 mr-0.5" />
                    Re-dispatch
                  </Button>
                )}
              </div>
            );
          })}

          {stageChange && (
            <p className="text-xs text-muted-foreground italic pt-1">
              → promoveu para{' '}
              <code className="px-1 py-0.5 rounded bg-muted text-foreground">
                {String(stageChange.payload.stage ?? '?')}
              </code>
            </p>
          )}

          {orderBumps && orderBumps.length > 0 && (
            <div className="mt-2 pt-2 border-t border-dashed space-y-1">
              {/* produto principal */}
              {(() => {
                const cd = isRecord(customData) ? customData : null;
                const name = cd?.product_name as string | undefined;
                const amt = cd?.amount as number | undefined;
                const cur = (cd?.currency as string | undefined) ?? currency ?? 'BRL';
                const formatted = amt != null
                  ? amt.toLocaleString('pt-BR', { style: 'currency', currency: cur })
                  : null;
                return (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">produto</span>
                    <span className="font-medium text-foreground">{name ?? eventName}</span>
                    {formatted && <span>{formatted}</span>}
                  </div>
                );
              })()}
              {/* order bumps */}
              {orderBumps.map((ob) => {
                const formatted = ob.amount != null
                  ? ob.amount.toLocaleString('pt-BR', { style: 'currency', currency: ob.currency ?? 'BRL' })
                  : null;
                return (
                  <div key={ob.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">order bump</span>
                    <span className="font-medium text-foreground">{ob.productName}</span>
                    {formatted && <span>{formatted}</span>}
                    <span className="ml-auto italic">consolidado no despacho acima</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Toggle "Ver detalhes" */}
        <div className="border-t px-4 py-2">
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={detailsId}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {expanded ? 'Ocultar detalhes' : 'Ver detalhes'}
          </button>
        </div>

        {/* Body expandido */}
        {expanded && (
          <div id={detailsId} className="border-t px-4 py-3 space-y-4 text-xs">
            {/* Dados do evento */}
            {isRecord(customData) && Object.keys(customData).length > 0 && (
              <section>
                <h4 className="font-semibold mb-1.5">Dados do evento</h4>

                {orderBumps && orderBumps.length > 0 ? (() => {
                  const cd = customData as Record<string, unknown>;
                  const mainAmt = cd.amount as number | undefined;
                  const cur = (cd.currency as string | undefined) ?? 'BRL';
                  const fmt = (amt: number) =>
                    amt.toLocaleString('pt-BR', { style: 'currency', currency: cur });
                  const obTotal = orderBumps.reduce((s, ob) => s + (ob.amount ?? 0), 0);
                  const total = (mainAmt ?? 0) + obTotal;
                  const SKIP = new Set(['amount', 'currency', 'product_name', 'item_type', 'transaction_group_id']);
                  const extras = Object.entries(cd).filter(([k]) => !SKIP.has(k));
                  return (
                    <div className="space-y-3">
                      {/* Itens individuais */}
                      <div>
                        <p className="text-muted-foreground mb-1">Itens</p>
                        <table className="w-full">
                          <tbody>
                            <tr className="border-b border-muted">
                              <td className="py-1 pr-2 text-muted-foreground">produto</td>
                              <td className="py-1 font-medium">{cd.product_name as string ?? eventName}</td>
                              <td className="py-1 text-right">{mainAmt != null ? fmt(mainAmt) : '—'}</td>
                            </tr>
                            {orderBumps.map((ob) => (
                              <tr key={ob.key} className="border-b border-muted last:border-0">
                                <td className="py-1 pr-2 text-muted-foreground">order bump</td>
                                <td className="py-1 font-medium">{ob.productName}</td>
                                <td className="py-1 text-right">{ob.amount != null ? fmt(ob.amount) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {/* Total consolidado enviado */}
                      <div className="rounded-md bg-muted/50 px-3 py-2 space-y-0.5">
                        <p className="text-muted-foreground">Total enviado (consolidado)</p>
                        <p className="font-semibold text-sm">{fmt(total)} <span className="font-normal text-muted-foreground">{cur}</span></p>
                        <p className="text-[10px] text-muted-foreground">transaction_group_id: <span className="font-mono">{cd.transaction_group_id as string}</span></p>
                      </div>
                      {/* Demais campos */}
                      {extras.length > 0 && (
                        <table className="w-full">
                          <tbody>
                            {extras.map(([k, v]) => (
                              <tr key={k} className="border-b border-muted last:border-0">
                                <td className="py-1 pr-2 text-muted-foreground font-mono">{k}</td>
                                <td className="py-1 font-mono break-all">{String(v)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })() : (
                  <table className="w-full">
                    <tbody>
                      {Object.entries(customData).map(([k, v]) => (
                        <tr key={k} className="border-b border-muted last:border-0">
                          <td className="py-1 pr-2 text-muted-foreground font-mono">{k}</td>
                          <td className="py-1 font-mono break-all">{String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            )}

            {/* Atribuição completa */}
            {isRecord(attributionSnapshot) &&
              Object.keys(attributionSnapshot).length > 0 && (
                <section>
                  <h4 className="font-semibold mb-1.5">Atribuição completa</h4>
                  <pre className="rounded-md bg-muted p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                    {JSON.stringify(attributionSnapshot, null, 2)}
                  </pre>
                </section>
              )}

            {/* Despachos detalhados */}
            {dispatches.length > 0 && (
              <section>
                <h4 className="font-semibold mb-1.5">Despachos detalhados</h4>
                <div className="space-y-3">
                  {dispatches.map((d) => {
                    const destLabel =
                      DESTINATION_LABEL[d.destination ?? ''] ??
                      d.destination ??
                      'desconhecido';
                    const showWhy =
                      d.status === 'failed' || d.status === 'skipped';
                    return (
                      <div key={d.id} className="rounded border bg-card p-2 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant={dispatchStatusVariant(d.status)}
                            className="text-[10px]"
                          >
                            {dispatchStatusLabel(d.status)}
                          </Badge>
                          <span className="font-medium">{destLabel}</span>
                          {d.payload.destination_resource_id != null && (
                            <span className="text-muted-foreground font-mono text-[10px]">
                              → {String(d.payload.destination_resource_id)}
                            </span>
                          )}
                        </div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                          {canSeePii && d.payload.response_code != null && (
                            <>
                              <dt className="text-muted-foreground">response</dt>
                              <dd>{String(d.payload.response_code)}</dd>
                            </>
                          )}
                          {d.payload.attempt_count != null && (
                            <>
                              <dt className="text-muted-foreground">attempts</dt>
                              <dd>{String(d.payload.attempt_count)}</dd>
                            </>
                          )}
                          {d.payload.next_attempt_at != null && (
                            <>
                              <dt className="text-muted-foreground">next_attempt</dt>
                              <dd>
                                {new Date(
                                  String(d.payload.next_attempt_at),
                                ).toLocaleString('pt-BR')}
                              </dd>
                            </>
                          )}
                          {d.skip_reason && (
                            <>
                              <dt className="text-muted-foreground">skip_reason</dt>
                              <dd className="italic">{d.skip_reason}</dd>
                            </>
                          )}
                        </dl>
                        {/* request_payload — gated por role (BR-PRIVACY-001) */}
                        {canSeePii && d.payload.request_payload != null && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                              request_payload
                            </summary>
                            <pre className="mt-1 rounded bg-muted p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">
                              {JSON.stringify(d.payload.request_payload, null, 2)}
                            </pre>
                          </details>
                        )}
                        <div className="flex items-center gap-2 pt-1">
                          {showWhy && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() =>
                                handleWhyFailed(d.skip_reason ?? d.type)
                              }
                            >
                              <HelpCircle className="h-3 w-3 mr-1" />
                              Por que falhou?
                            </Button>
                          )}
                          {d.can_replay && canRedispatch && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => handleRedispatch(d.id)}
                            >
                              <RefreshCw className="h-3 w-3 mr-1" />
                              Re-dispatch
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Processamento */}
            {processingStatus && (
              <section>
                <h4 className="font-semibold mb-1.5">Processamento</h4>
                <p>
                  <span className="text-muted-foreground">status:</span>{' '}
                  <code className="px-1 py-0.5 rounded bg-muted">
                    {processingStatus}
                  </code>
                </p>
              </section>
            )}
          </div>
        )}
      </Card>

      <WhyFailedSheet
        reason={whyReason}
        open={whySheetOpen}
        onClose={() => setWhySheetOpen(false)}
      />

      {redispatchJobId && (
        <RedispatchDialog
          open={redispatchOpen}
          onOpenChange={(open) => {
            setRedispatchOpen(open);
            if (!open) setRedispatchJobId(null);
          }}
          jobId={redispatchJobId}
        />
      )}
    </article>
  );
}
