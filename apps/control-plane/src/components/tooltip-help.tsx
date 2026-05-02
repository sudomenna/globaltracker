'use client';

import { cn } from '@/lib/utils';
import { Info } from 'lucide-react';
import { useId, useRef, useState } from 'react';

export interface TooltipHelpProps {
  content: string;
  children?: React.ReactNode;
  className?: string;
}

export function TooltipHelp({
  content,
  children,
  className,
}: TooltipHelpProps) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function openImmediate() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setOpen(true);
  }

  // Desktop hover: 300ms delay per spec (docs/70-ux/08-pattern-contextual-help.md §1.5)
  function openDelayed() {
    timerRef.current = setTimeout(() => setOpen(true), 300);
  }

  function close() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setOpen(false);
  }

  const triggerProps = {
    onMouseEnter: openDelayed,
    onMouseLeave: close,
    onFocus: openImmediate,
    onBlur: close,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    },
  };

  return (
    <span className={cn('relative inline-flex items-center', className)}>
      {children != null ? (
        <span aria-describedby={open ? tooltipId : undefined} {...triggerProps}>
          {children}
        </span>
      ) : (
        <button
          type="button"
          aria-label={content}
          aria-describedby={open ? tooltipId : undefined}
          className="inline-flex items-center text-muted-foreground cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          {...triggerProps}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className={cn(
            'absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50',
            'max-w-xs w-max px-3 py-2 text-xs rounded-md shadow-md',
            'bg-gray-900 text-white pointer-events-none',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
