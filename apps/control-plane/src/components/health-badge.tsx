'use client';

import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle, HelpCircle, XCircle } from 'lucide-react';

// Canonical health states per docs/70-ux/07-component-health-badges.md §1
export type HealthState =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unknown'
  | 'loading';

export interface HealthBadgeProps {
  state: HealthState;
  size?: 'xs' | 'sm' | 'md';
  label?: string;
  incidentCount?: number;
  tooltip?: string;
  onClick?: () => void;
  className?: string;
}

const STATE_CONFIG: Record<
  Exclude<HealthState, 'loading'>,
  {
    color: string;
    Icon: React.ElementType;
    defaultLabel: string;
    ariaLabel: string;
  }
> = {
  // color.feedback.success per docs/70-ux/01-design-system-tokens.md
  healthy: {
    color: '#22c55e',
    Icon: CheckCircle,
    defaultLabel: 'Saudável',
    ariaLabel: 'Saudável',
  },
  // color.feedback.warning
  degraded: {
    color: '#f59e0b',
    Icon: AlertTriangle,
    defaultLabel: 'Atenção',
    ariaLabel: 'Atenção',
  },
  // color.feedback.danger
  unhealthy: {
    color: '#ef4444',
    Icon: XCircle,
    defaultLabel: 'Crítico',
    ariaLabel: 'Crítico',
  },
  // color.feedback.muted
  unknown: {
    color: '#6b7280',
    Icon: HelpCircle,
    defaultLabel: 'Sem dados',
    ariaLabel: 'Sem dados',
  },
};

function DotXs({
  state,
  tooltip,
  onClick,
  className,
}: Pick<HealthBadgeProps, 'state' | 'tooltip' | 'onClick' | 'className'>) {
  // A11y: never color alone — always color + icon + aria-label (WCAG AA)
  // See docs/70-ux/10-accessibility.md
  if (state === 'loading') {
    const dot = (
      <output
        className={cn(
          'inline-block h-2 w-2 rounded-full animate-pulse bg-gray-200',
          className,
        )}
        aria-label="Carregando"
      />
    );
    return tooltip ? <Tooltip content={tooltip}>{dot}</Tooltip> : dot;
  }

  const { color, Icon, ariaLabel } = STATE_CONFIG[state];
  const dot = (
    <span
      className={cn(
        'relative inline-flex h-2 w-2 items-center justify-center',
        onClick && 'cursor-pointer',
        className,
      )}
      aria-label={ariaLabel}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
    >
      {/* Visible dot circle */}
      <span
        className="block h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {/* SR-only icon for a11y — never color alone */}
      <span className="sr-only">
        <Icon aria-hidden="true" />
      </span>
    </span>
  );

  return tooltip ? <Tooltip content={tooltip}>{dot}</Tooltip> : dot;
}

function DotSm({
  state,
  label,
  incidentCount,
  tooltip,
  onClick,
  className,
}: Pick<
  HealthBadgeProps,
  'state' | 'label' | 'incidentCount' | 'tooltip' | 'onClick' | 'className'
>) {
  if (state === 'loading') {
    const content = (
      <output
        className={cn('inline-flex items-center gap-1.5', className)}
        aria-label="Carregando"
      >
        <span
          className="h-2.5 w-2.5 rounded-full animate-pulse bg-gray-200"
          aria-hidden="true"
        />
        <span
          className="h-3 w-16 rounded animate-pulse bg-gray-200"
          aria-hidden="true"
        />
      </output>
    );
    return tooltip ? <Tooltip content={tooltip}>{content}</Tooltip> : content;
  }

  const { color, Icon, defaultLabel, ariaLabel } = STATE_CONFIG[state];
  const displayLabel = label ?? defaultLabel;
  const resolvedAriaLabel = `${ariaLabel}${incidentCount && incidentCount > 0 ? ` — ${incidentCount} incidentes` : ''}`;

  const content = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-sm',
        onClick && 'cursor-pointer',
        className,
      )}
      aria-label={resolvedAriaLabel}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
    >
      {/* A11y: color + icon together (never color alone) */}
      <Icon
        className="h-2.5 w-2.5 shrink-0"
        style={{ color }}
        aria-hidden="true"
      />
      <span>{displayLabel}</span>
      {incidentCount != null && incidentCount > 0 && (
        <span className="text-muted-foreground">({incidentCount})</span>
      )}
    </span>
  );

  return tooltip ? <Tooltip content={tooltip}>{content}</Tooltip> : content;
}

function CardMd({
  state,
  label,
  incidentCount,
  tooltip,
  onClick,
  className,
}: Pick<
  HealthBadgeProps,
  'state' | 'label' | 'incidentCount' | 'tooltip' | 'onClick' | 'className'
>) {
  if (state === 'loading') {
    const content = (
      <output
        className={cn(
          'rounded-lg border p-3 flex flex-col gap-1 animate-pulse',
          className,
        )}
        aria-label="Carregando"
      >
        <div className="h-4 w-24 rounded bg-gray-200" aria-hidden="true" />
        <div className="h-3 w-32 rounded bg-gray-200" aria-hidden="true" />
      </output>
    );
    return tooltip ? <Tooltip content={tooltip}>{content}</Tooltip> : content;
  }

  const { color, Icon, defaultLabel, ariaLabel } = STATE_CONFIG[state];
  const displayLabel = label ?? defaultLabel;

  const content = (
    <div
      className={cn(
        'rounded-lg border p-3 flex flex-col gap-0.5',
        onClick && 'cursor-pointer hover:bg-accent transition-colors',
        className,
      )}
      aria-label={ariaLabel}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
    >
      <div className="inline-flex items-center gap-1.5 text-sm font-medium">
        {/* A11y: color + icon (never color alone) */}
        <Icon
          className="h-4 w-4 shrink-0"
          style={{ color }}
          aria-hidden="true"
        />
        <span>{displayLabel}</span>
        {incidentCount != null && incidentCount > 0 && (
          <span className="text-muted-foreground text-xs">
            ({incidentCount})
          </span>
        )}
      </div>
    </div>
  );

  return tooltip ? <Tooltip content={tooltip}>{content}</Tooltip> : content;
}

/**
 * HealthBadge — indicação visual de saúde em três tamanhos.
 *
 * docs/70-ux/07-component-health-badges.md §2, §6
 * A11y: WCAG AA — nunca cor sozinha, sempre cor + ícone + aria-label.
 * docs/70-ux/10-accessibility.md
 */
export function HealthBadge({
  state,
  size = 'sm',
  label,
  incidentCount,
  tooltip,
  onClick,
  className,
}: HealthBadgeProps) {
  if (size === 'xs') {
    return (
      <DotXs
        state={state}
        tooltip={tooltip}
        onClick={onClick}
        className={className}
      />
    );
  }

  if (size === 'md') {
    return (
      <CardMd
        state={state}
        label={label}
        incidentCount={incidentCount}
        tooltip={tooltip}
        onClick={onClick}
        className={className}
      />
    );
  }

  // default: size='sm'
  return (
    <DotSm
      state={state}
      label={label}
      incidentCount={incidentCount}
      tooltip={tooltip}
      onClick={onClick}
      className={className}
    />
  );
}
