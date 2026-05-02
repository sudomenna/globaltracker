'use client';

import { cn } from '@/lib/utils';
import * as React from 'react';
import { Button } from './button';

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

interface AlertDialogContentProps {
  children: React.ReactNode;
  className?: string;
}

interface AlertDialogHeaderProps {
  children: React.ReactNode;
  className?: string;
}

interface AlertDialogFooterProps {
  children: React.ReactNode;
  className?: string;
}

const AlertDialogContext = React.createContext<{
  onClose: () => void;
}>({ onClose: () => {} });

function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
  if (!open) return null;

  return (
    <AlertDialogContext.Provider value={{ onClose: () => onOpenChange(false) }}>
      <dialog
        open
        className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-0 max-w-none w-full h-full border-0"
        aria-modal="true"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: aria-hidden overlay; keyboard close handled by dialog Escape semantics */}
        <div
          className="fixed inset-0 bg-black/50"
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
        <div className="relative z-50">{children}</div>
      </dialog>
    </AlertDialogContext.Provider>
  );
}

function AlertDialogContent({ children, className }: AlertDialogContentProps) {
  return (
    <div
      className={cn(
        'bg-background rounded-lg border shadow-lg p-6 w-full max-w-md mx-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

function AlertDialogHeader({ children, className }: AlertDialogHeaderProps) {
  return (
    <div className={cn('flex flex-col space-y-2 mb-4', className)}>
      {children}
    </div>
  );
}

function AlertDialogTitle({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn('text-lg font-semibold', className)}>{children}</h2>;
}

function AlertDialogDescription({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)}>{children}</p>
  );
}

function AlertDialogFooter({ children, className }: AlertDialogFooterProps) {
  return (
    <div className={cn('flex justify-end gap-2 mt-4', className)}>
      {children}
    </div>
  );
}

function AlertDialogCancel({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  const { onClose } = React.useContext(AlertDialogContext);
  return (
    <Button variant="outline" onClick={onClose} className={className}>
      {children}
    </Button>
  );
}

function AlertDialogAction({
  children,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      variant="destructive"
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      {children}
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
};
