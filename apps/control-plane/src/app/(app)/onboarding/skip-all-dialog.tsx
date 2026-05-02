'use client';

// Padrao de confirmacao destrutiva — docs/70-ux/09-interaction-patterns.md §Confirmação destrutiva
// Skip total requer confirmacao explicita antes de marcar skipped_at

import { Button } from '@/components/ui/button';
import { useEffect, useRef, useState } from 'react';

const CONFIRM_PHRASE = 'PULAR CONFIGURACAO';

interface SkipAllDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function SkipAllDialog({
  open,
  onCancel,
  onConfirm,
}: SkipAllDialogProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) {
      setInput('');
      dialogRef.current?.showModal();
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      dialogRef.current?.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      e.preventDefault();
      onCancel();
    }
    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onCancel]);

  if (!open) return null;

  const confirmed = input.trim().toUpperCase() === CONFIRM_PHRASE;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="skip-all-title"
      aria-describedby="skip-all-desc"
      className="fixed inset-0 z-50 m-auto w-full max-w-md rounded-lg border bg-card p-6 shadow-lg backdrop:bg-background/80 backdrop:backdrop-blur-sm open:flex open:flex-col open:gap-4"
    >
      <div>
        <h2 id="skip-all-title" className="text-lg font-semibold">
          Pular configuracao
        </h2>
        <p id="skip-all-desc" className="text-sm text-muted-foreground mt-1">
          Voce pode configurar tudo via API ou voltar depois em{' '}
          <strong>Configuracoes &rarr; Onboarding</strong>.
        </p>
        <p className="text-sm text-muted-foreground mt-1">Tem certeza?</p>
      </div>

      <div className="space-y-2">
        <label htmlFor="skip-confirm-input" className="text-sm font-medium">
          Digite{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {CONFIRM_PHRASE}
          </code>{' '}
          para confirmar
        </label>
        <input
          id="skip-confirm-input"
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          autoComplete="off"
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          variant="destructive"
          disabled={!confirmed}
          onClick={onConfirm}
          aria-disabled={!confirmed}
        >
          Pular onboarding
        </Button>
      </div>
    </dialog>
  );
}
