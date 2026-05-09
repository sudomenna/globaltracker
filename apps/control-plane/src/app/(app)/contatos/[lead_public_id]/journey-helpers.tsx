'use client';

/**
 * journey-helpers.tsx — sub-componentes auxiliares da aba Jornada.
 *
 * Onda 4 (Sprint 17): T-17-014.
 * Componentes:
 *   - <StageDivider>  — divisor visual quando lead muda de stage
 *   - <OriginBadge>   — badge colorido por event_source
 *   - <MoneyValue>    — valor monetário formatado pt-BR
 *   - <TagBadge>      — badge verde para tag aplicada
 *   - <PageInline>    — linha pequena com page.name + launch.name
 *
 * BR-IDENTITY-013: nunca expõe lead_id interno (todos os helpers operam só com
 * dados de payload já sanitizados pela API).
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { FileText, Rocket } from 'lucide-react';

// ---------------------------------------------------------------------------
// <StageDivider>
// ---------------------------------------------------------------------------
interface StageDividerProps {
  stage: string;
  timestamp: string;
}

export function StageDivider({ stage, timestamp }: StageDividerProps) {
  const ts = new Date(timestamp).toLocaleString('pt-BR');
  return (
    <div className="my-4 flex items-center gap-3" role="separator">
      <div className="flex-1 h-px bg-primary/20" aria-hidden="true" />
      <div className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary uppercase tracking-wide">
        STAGE: {stage} <span className="font-normal opacity-70">· {ts}</span>
      </div>
      <div className="flex-1 h-px bg-primary/20" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// <OriginBadge>
// ---------------------------------------------------------------------------
interface OriginBadgeProps {
  source: string | null | undefined;
}

const ORIGIN_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  'tracker.js': {
    bg: 'bg-blue-100',
    text: 'text-blue-800',
    label: 'tracker.js',
  },
  'webhook:guru': {
    bg: 'bg-orange-100',
    text: 'text-orange-800',
    label: 'guru',
  },
  'webhook:sendflow': {
    bg: 'bg-purple-100',
    text: 'text-purple-800',
    label: 'sendflow',
  },
  'webhook:hotmart': {
    bg: 'bg-pink-100',
    text: 'text-pink-800',
    label: 'hotmart',
  },
  'webhook:kiwify': {
    bg: 'bg-green-100',
    text: 'text-green-800',
    label: 'kiwify',
  },
  'webhook:stripe': {
    bg: 'bg-indigo-100',
    text: 'text-indigo-800',
    label: 'stripe',
  },
};

export function OriginBadge({ source }: OriginBadgeProps) {
  if (!source) {
    return (
      <Badge variant="secondary" className="text-xs">
        unknown
      </Badge>
    );
  }
  const style = ORIGIN_STYLE[source];
  if (!style) {
    return (
      <Badge variant="secondary" className="text-xs">
        {source}
      </Badge>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        style.bg,
        style.text,
      )}
    >
      {style.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// <MoneyValue>
// ---------------------------------------------------------------------------
interface MoneyValueProps {
  value: unknown;
  currency?: string | null;
}

export function MoneyValue({ value, currency }: MoneyValueProps) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  const formatted = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: currency ?? 'BRL',
  }).format(num);
  return (
    <span className="font-semibold text-foreground" aria-label={`Valor: ${formatted}`}>
      {formatted}
    </span>
  );
}

// ---------------------------------------------------------------------------
// <TagBadge>
// ---------------------------------------------------------------------------
interface TagBadgeProps {
  name: string;
}

export function TagBadge({ name }: TagBadgeProps) {
  return (
    <Badge variant="success" className="text-xs">
      +#{name}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// <PageInline>
// ---------------------------------------------------------------------------
interface PageInlineProps {
  pageName: string | null | undefined;
  launchName: string | null | undefined;
}

export function PageInline({ pageName, launchName }: PageInlineProps) {
  if (!pageName && !launchName) return null;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      {pageName && (
        <span className="inline-flex items-center gap-1">
          <FileText className="h-3 w-3" aria-hidden="true" />
          {pageName}
        </span>
      )}
      {launchName && (
        <span className="inline-flex items-center gap-1">
          <Rocket className="h-3 w-3" aria-hidden="true" />
          {launchName}
        </span>
      )}
    </span>
  );
}
