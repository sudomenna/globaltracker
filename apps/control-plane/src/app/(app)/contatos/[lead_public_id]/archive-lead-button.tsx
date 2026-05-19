'use client';

import { Archive, ArchiveRestore, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  leadPublicId: string;
  accessToken: string;
  edgeUrl: string;
  /** Current lead status — drives label (Arquivar vs Restaurar) and visibility. */
  status: 'active' | 'merged' | 'erased' | 'archived';
}

export function ArchiveLeadButton({
  leadPublicId,
  accessToken,
  edgeUrl,
  status,
}: Props) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  // No action makes sense for merged or erased leads.
  if (status === 'merged' || status === 'erased') return null;

  const isArchived = status === 'archived';
  const endpoint = isArchived ? 'bulk-unarchive' : 'bulk-archive';
  const Icon = isArchived ? ArchiveRestore : Archive;
  const label = isArchived ? 'Restaurar' : 'Arquivar';

  async function handleClick() {
    setBusy(true);
    try {
      const res = await fetch(`${edgeUrl}/v1/leads/${endpoint}`, {
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
          alert('Você não tem permissão.');
        } else {
          alert(`Falha (HTTP ${res.status}). Tente novamente.`);
        }
        return;
      }
      // Archived → user went from "active detail" to "should be invisible";
      // send them back to the list. Restored → just refresh to flip the badge.
      if (isArchived) {
        router.refresh();
      } else {
        router.push('/contatos');
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Icon className="h-4 w-4" aria-hidden="true" />}
      {label}
    </button>
  );
}
