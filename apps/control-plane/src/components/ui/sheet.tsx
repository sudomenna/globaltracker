'use client';

import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Sheet({ open, onOpenChange, children }: SheetProps) {
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <>
      {/* Overlay — aria-hidden, keyboard close handled by Escape listener above */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: aria-hidden overlay; keyboard close via document keydown */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
      />
      {children}
    </>,
    document.body,
  );
}

interface SheetContentProps {
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}

function SheetContent({ children, className, ...props }: SheetContentProps) {
  return (
    <dialog
      open
      aria-modal="true"
      className={cn(
        'fixed right-0 top-0 z-50 h-full w-80 bg-card shadow-xl',
        'flex flex-col border-l',
        'animate-in slide-in-from-right duration-200',
        className,
      )}
      {...props}
    >
      {children}
    </dialog>
  );
}

interface SheetHeaderProps {
  children: React.ReactNode;
  onClose?: () => void;
  className?: string;
}

function SheetHeader({ children, onClose, className }: SheetHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between border-b px-4 py-3',
        className,
      )}
    >
      {children}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar painel"
          className="rounded p-1 hover:bg-accent transition-colors"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function SheetTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <h2 className={cn('text-sm font-semibold', className)}>{children}</h2>;
}

function SheetBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex-1 overflow-y-auto px-4 py-3', className)}>
      {children}
    </div>
  );
}

export { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle };
