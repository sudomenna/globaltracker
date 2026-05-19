'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  leadPublicId: string;
  accessToken: string;
  edgeUrl: string;
  /** When true, button is hidden — lead already anonymized. */
  alreadyErased?: boolean;
}

export function DeleteLeadButton({
  leadPublicId,
  accessToken,
  edgeUrl,
  alreadyErased,
}: Props) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (alreadyErased) return null;

  async function handleClick() {
    const ok = window.confirm(
      'Excluir este contato?\n\nEsta ação anonimiza o contato (PII removida) e não pode ser desfeita.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`${edgeUrl}/v1/leads/bulk-delete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lead_public_ids: [leadPublicId] }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          alert('Sessão expirada. Faça login novamente.');
          window.location.href = '/login';
        } else if (res.status === 403) {
          alert('Você não tem permissão para excluir contatos.');
        } else {
          alert(`Falha ao excluir (HTTP ${res.status}). Tente novamente.`);
        }
        return;
      }
      // Anonymization is async (queue worker). Send the user back to the list
      // and refresh — within a few seconds the row will show as "Anonimizado".
      router.push('/contatos');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-destructive/30 bg-background px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      )}
      Excluir contato
    </button>
  );
}
