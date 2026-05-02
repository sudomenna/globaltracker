'use client';

// T-7-009 — Client Component for approve/rollback actions

import { Button } from '@/components/ui/button';

interface RunActionsProps {
  runId: string;
  status: string;
  accessToken: string;
}

export function RunActions({ runId, status, accessToken }: RunActionsProps) {
  const baseUrl =
    process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

  const canApprove = status === 'waiting_approval';
  const canRollback = ['waiting_approval', 'completed', 'failed'].includes(
    status,
  );

  async function handleApprove() {
    const justification = window.prompt(
      'Justificativa para aprovação (mín. 10, máx. 500 caracteres):',
    );
    if (!justification) return;
    if (justification.length < 10 || justification.length > 500) {
      window.alert('Justificativa deve ter entre 10 e 500 caracteres.');
      return;
    }
    try {
      const res = await fetch(
        `${baseUrl}/v1/orchestrator/workflows/${runId}/approve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ justification }),
        },
      );
      if (res.ok) {
        window.alert('Workflow aprovado com sucesso.');
        window.location.reload();
      } else if (res.status === 409) {
        window.alert('Este workflow não pode ser aprovado no estado atual.');
      } else {
        window.alert(`Erro ao aprovar (${res.status}).`);
      }
    } catch {
      window.alert('Erro de conexão com o servidor.');
    }
  }

  async function handleRollback() {
    const reason = window.prompt(
      'Motivo do rollback (mín. 10, máx. 500 caracteres):',
    );
    if (!reason) return;
    if (reason.length < 10 || reason.length > 500) {
      window.alert('Motivo deve ter entre 10 e 500 caracteres.');
      return;
    }
    try {
      const res = await fetch(
        `${baseUrl}/v1/orchestrator/workflows/${runId}/rollback`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ reason }),
        },
      );
      if (res.ok) {
        window.alert('Rollback solicitado com sucesso.');
        window.location.reload();
      } else if (res.status === 409) {
        window.alert('Este workflow não pode ser revertido no estado atual.');
      } else {
        window.alert(`Erro ao solicitar rollback (${res.status}).`);
      }
    } catch {
      window.alert('Erro de conexão com o servidor.');
    }
  }

  return (
    <div className="flex gap-3">
      {canApprove && <Button onClick={handleApprove}>Aprovar</Button>}
      {canRollback && (
        <Button variant="destructive" onClick={handleRollback}>
          Rollback
        </Button>
      )}
      {!canApprove && !canRollback && (
        <p className="text-sm text-muted-foreground">
          Nenhuma ação disponível para o status atual.
        </p>
      )}
    </div>
  );
}
