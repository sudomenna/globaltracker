'use client';

/**
 * consent-tab.tsx — Sprint 17 / T-17-018
 *
 * Shows the lead's current consent state (5 finalities) and the historical
 * trail of `consent_updated` timeline entries. Read-only — consent changes
 * are owned by the tracker / webhook adapters, never by the CP UI.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type NodeType,
  type TimelineNode,
  useTimeline,
} from './use-timeline';

interface ConsentTabProps {
  leadPublicId: string;
}

const CONSENT_TYPES: NodeType[] = ['consent_updated'];

const FINALITIES: Array<{
  key: 'analytics' | 'marketing' | 'ad_user_data' | 'ad_personalization' | 'customer_match';
  label: string;
}> = [
  { key: 'analytics', label: 'Analytics' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'ad_user_data', label: 'Ad user data' },
  { key: 'ad_personalization', label: 'Ad personalization' },
  { key: 'customer_match', label: 'Customer match' },
];

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function isTrueLike(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s === 'granted' || s === 'true' || s === 'on' || s === 'yes';
  }
  return false;
}

function formatDiff(diff: unknown): Array<{ key: string; value: string }> {
  const obj = asObject(diff);
  if (!obj) return [];
  return Object.entries(obj).map(([k, v]) => ({
    key: k,
    value: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}

/**
 * Reconstrói o estado atual a partir do node mais recente: backend emite
 * `purposes_diff` contendo apenas as finalidades alteradas — para a primeira
 * linha, o snapshot completo. Como a API entrega ordenação descendente,
 * percorremos do mais antigo ao mais novo aplicando cada diff.
 */
function reconstructCurrentState(
  nodes: TimelineNode[],
): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  // Process oldest -> newest so newer diffs win.
  const ordered = [...nodes].sort(
    (a, b) =>
      new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  );
  for (const n of ordered) {
    const diff = asObject(n.payload.purposes_diff);
    if (!diff) continue;
    for (const f of FINALITIES) {
      if (f.key in diff) {
        state[f.key] = isTrueLike(diff[f.key]);
      }
    }
  }
  return state;
}

export function ConsentTab({ leadPublicId }: ConsentTabProps) {
  const { error, isLoading, isValidating, mutate, allNodes } = useTimeline({
    leadPublicId,
    typeFilter: CONSENT_TYPES,
    statusFilter: 'all',
    period: 'all',
  });

  const currentState = reconstructCurrentState(allNodes);

  return (
    <div className="space-y-6">
      {/* Estado atual */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Estado atual</h2>
        {isLoading ? (
          <div className="flex flex-wrap gap-2">
            {FINALITIES.map((f) => (
              <Skeleton key={f.key} className="h-6 w-32" />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {FINALITIES.map((f) => {
              const value = currentState[f.key] ?? false;
              return (
                <Badge
                  key={f.key}
                  variant={value ? 'success' : 'outline'}
                  aria-label={`${f.label}: ${value ? 'ON' : 'OFF'}`}
                >
                  {f.label}: {value ? 'ON' : 'OFF'}
                </Badge>
              );
            })}
          </div>
        )}
      </section>

      {/* Histórico */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Histórico</h2>

        {isLoading && (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {!isLoading && error && (
          <div className="text-center py-12 space-y-3">
            <p className="text-sm text-muted-foreground">
              Não foi possível carregar o consentimento.
            </p>
            <Button variant="outline" size="sm" onClick={() => void mutate()}>
              Tentar novamente
            </Button>
          </div>
        )}

        {!isLoading && !error && allNodes.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm text-muted-foreground">
              Sem registros de consentimento.
            </p>
          </div>
        )}

        {!isLoading && !error && allNodes.length > 0 && (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-muted/40">
                <tr className="border-b">
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Quando
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Fonte
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Versão
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Mudanças
                  </th>
                </tr>
              </thead>
              <tbody>
                {allNodes.map((n) => {
                  const ts = new Date(n.occurred_at).toLocaleString('pt-BR');
                  const source = asString(n.payload.source) ?? '—';
                  const policyVersion =
                    asString(n.payload.policy_version) ?? '—';
                  const diff = formatDiff(n.payload.purposes_diff);
                  return (
                    <tr key={n.id} className="border-b align-top">
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {ts}
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <Badge variant="outline">{source}</Badge>
                      </td>
                      <td className="px-3 py-2 text-sm font-mono">
                        {policyVersion}
                      </td>
                      <td className="px-3 py-2 text-sm">
                        {diff.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {diff.map((d) => (
                              <li key={d.key} className="font-mono text-xs">
                                <span className="text-muted-foreground">
                                  {d.key}:
                                </span>{' '}
                                {d.value}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {isValidating && !isLoading && (
          <p className="text-xs text-muted-foreground">Atualizando…</p>
        )}
      </section>
    </div>
  );
}
