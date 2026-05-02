'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

interface Issue {
  type: string;
  domain?: string;
  count: number;
  last_seen_at: string;
}

interface Props {
  issues: Issue[];
  lastPingAt: string | null;
  healthState: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  onScrollToSnippet: () => void;
  onAddDomain: (domain: string) => void;
}

const STALE_PING_HOURS = 24;

function isNoPingRecent(lastPingAt: string | null): boolean {
  if (lastPingAt === null) return true;
  const diffMs = Date.now() - new Date(lastPingAt).getTime();
  return diffMs > STALE_PING_HOURS * 60 * 60 * 1000;
}

function relativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `há ${diffMin}min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH}h`;
  return `há ${Math.floor(diffH / 24)}d`;
}

function OriginNotAllowedIssue({
  issue,
  onAddDomain,
}: {
  issue: Issue;
  onAddDomain: (domain: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [inputValue, setInputValue] = useState(issue.domain ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleAdd() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    // Caller handles the actual PATCH — this is a TODO for the PATCH endpoint
    onAddDomain(trimmed);
    setIsSubmitting(false);
    setFormOpen(false);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm">
        Detectamos <strong>{issue.count}</strong>{' '}
        {issue.count === 1 ? 'tentativa' : 'tentativas'} vindas de{' '}
        {issue.domain ? (
          <span className="font-mono text-xs bg-muted px-1 rounded">
            {issue.domain}
          </span>
        ) : (
          'domínio desconhecido'
        )}
        {issue.last_seen_at ? (
          <> (último: {relativeTime(issue.last_seen_at)})</>
        ) : null}
        . Como esse domínio não está na lista permitida, os eventos foram
        rejeitados — a página continua funcionando, mas nada chega no
        GlobalTracker.
      </p>

      {!formOpen ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setFormOpen(true)}
          className="gap-1.5"
        >
          + Adicionar{' '}
          {issue.domain ? (
            <span className="font-mono text-xs">{issue.domain}</span>
          ) : (
            'domínio'
          )}{' '}
          aos permitidos
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="ex: staging.cliente.com"
            aria-label="Domínio a adicionar"
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <Button
            type="button"
            size="sm"
            disabled={!inputValue.trim() || isSubmitting}
            onClick={handleAdd}
          >
            Adicionar
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setFormOpen(false);
              setInputValue(issue.domain ?? '');
            }}
          >
            Cancelar
          </Button>
        </div>
      )}
    </div>
  );
}

function InvalidTokenIssue({
  issue,
  onScrollToSnippet,
}: {
  issue: Issue;
  onScrollToSnippet: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Detectamos <strong>{issue.count}</strong>{' '}
        {issue.count === 1 ? 'requisição' : 'requisições'} com token rotacionado
        {issue.domain ? (
          <>
            {' '}
            em{' '}
            <span className="font-mono text-xs bg-muted px-1 rounded">
              {issue.domain}
            </span>
          </>
        ) : null}
        {issue.last_seen_at ? (
          <> (último: {relativeTime(issue.last_seen_at)})</>
        ) : null}
        . Isso geralmente significa que o snippet antigo ainda está no{' '}
        <code className="font-mono text-xs bg-muted px-1 rounded">
          &lt;head&gt;
        </code>{' '}
        da LP.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onScrollToSnippet}
        className="gap-1.5"
      >
        Ver snippet atual
      </Button>
    </div>
  );
}

function NoPingChecklist() {
  const [expanded, setExpanded] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const steps = [
    { id: 'lp-200', label: 'LP responde com 200 em fetch direto?' },
    {
      id: 'snippet-present',
      label: (
        <>
          Snippet presente no{' '}
          <code className="font-mono text-xs bg-muted px-1 rounded">
            &lt;head&gt;
          </code>{' '}
          (curl + grep)?
        </>
      ),
    },
    {
      id: 'cdn-accessible',
      label: (
        <>
          CDN do tracker.js acessível?{' '}
          <span className="font-mono text-xs text-muted-foreground">
            (cdn.globaltracker.io/tracker.js)
          </span>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm">
        Possíveis causas: snippet removido da LP, LP fora do ar, ou bloqueio por
        adblocker / firewall do cliente.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="gap-1.5"
      >
        {expanded ? (
          <>
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
            Ocultar checklist
          </>
        ) : (
          <>
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
            Diagnosticar
          </>
        )}
      </Button>

      {expanded && (
        <ul
          className="space-y-2 mt-2 pl-1"
          aria-label="Checklist de diagnóstico"
        >
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                id={`diag-${step.id}`}
                checked={checked[step.id] ?? false}
                onChange={(e) =>
                  setChecked((prev) => ({
                    ...prev,
                    [step.id]: e.target.checked,
                  }))
                }
                className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
                aria-label={
                  typeof step.label === 'string' ? step.label : undefined
                }
              />
              <label
                htmlFor={`diag-${step.id}`}
                className={cn(
                  'text-sm cursor-pointer',
                  checked[step.id] && 'line-through text-muted-foreground',
                )}
              >
                {step.label}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DiagnosticsPanel({
  issues,
  lastPingAt,
  healthState,
  onScrollToSnippet,
  onAddDomain,
}: Props) {
  const noPingRecent = isNoPingRecent(lastPingAt);
  const hasIssues = issues.length > 0;

  // Panel only appears when there are issues or no recent ping; disappears when healthy
  if (healthState === 'healthy' && !hasIssues) return null;
  if (!hasIssues && !noPingRecent) return null;

  const hoursAgo =
    lastPingAt !== null
      ? Math.floor(
          (Date.now() - new Date(lastPingAt).getTime()) / (60 * 60 * 1000),
        )
      : null;

  return (
    <Card
      className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800"
      role="alert"
      aria-label="Diagnóstico de instalação"
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle
            className="h-4 w-4 text-amber-500"
            aria-hidden="true"
          />
          Diagnóstico
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {issues.map((issue, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: recent_issues has no stable id
          <div key={i}>
            {issue.type === 'origin_not_allowed' && (
              <>
                <p className="text-sm font-medium mb-1">
                  Tracker rodando em domínio não autorizado
                </p>
                <OriginNotAllowedIssue
                  issue={issue}
                  onAddDomain={onAddDomain}
                />
              </>
            )}
            {issue.type === 'invalid_token' && (
              <>
                <p className="text-sm font-medium mb-1">
                  Snippet desatualizado em produção
                </p>
                <InvalidTokenIssue
                  issue={issue}
                  onScrollToSnippet={onScrollToSnippet}
                />
              </>
            )}
            {issue.type !== 'origin_not_allowed' &&
              issue.type !== 'invalid_token' && (
                <p className="text-sm">
                  {issue.type} — {issue.count} ocorrências
                  {issue.last_seen_at
                    ? ` (último: ${relativeTime(issue.last_seen_at)})`
                    : ''}
                </p>
              )}
          </div>
        ))}

        {noPingRecent && (
          <div>
            <p className="text-sm font-medium mb-1">
              {lastPingAt === null
                ? 'Nenhum evento recebido ainda'
                : `Nenhum evento recebido há ${hoursAgo}h`}
            </p>
            <NoPingChecklist />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
