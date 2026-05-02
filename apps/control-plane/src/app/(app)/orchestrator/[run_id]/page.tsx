// T-7-009 — Orchestrator run detail page (Server Component)

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { edgeFetch } from '@/lib/api-client';
import { createSupabaseServer } from '@/lib/supabase-server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RunActions } from './run-actions';

type RunData = {
  run_id: string;
  workflow: string;
  status: string;
  trigger_payload: unknown;
  result: unknown;
  created_at: string;
  updated_at: string;
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Badge variant="secondary">{status}</Badge>;
    case 'waiting_approval':
      return (
        <Badge
          variant="outline"
          className="border-blue-500 text-blue-600 animate-pulse"
        >
          {status}
        </Badge>
      );
    case 'completed':
      return <Badge className="bg-green-100 text-green-800">{status}</Badge>;
    case 'failed':
      return <Badge variant="destructive">{status}</Badge>;
    case 'rolled_back':
      return (
        <Badge variant="destructive" className="opacity-70">
          {status}
        </Badge>
      );
    case 'expired':
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {status}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

interface PageProps {
  params: Promise<{ run_id: string }>;
}

export default async function OrchestratorRunPage({ params }: PageProps) {
  const { run_id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const accessToken = session.access_token;

  let run: RunData | null = null;
  let fetchError: string | null = null;

  try {
    const res = await edgeFetch(
      `/v1/orchestrator/workflows/${run_id}/status`,
      accessToken,
    );
    if (res.ok) {
      run = (await res.json()) as RunData;
    } else if (res.status === 404) {
      fetchError = 'Workflow não encontrado';
    } else {
      fetchError = `Erro ao carregar workflow (${res.status})`;
    }
  } catch {
    fetchError = 'Erro de conexão com o servidor';
  }

  if (fetchError && !run) {
    return (
      <div className="space-y-6">
        <div>
          <nav
            className="text-xs text-muted-foreground mb-1"
            aria-label="Localização"
          >
            <Link href="/orchestrator" className="hover:underline">
              Workflows
            </Link>
            <span className="mx-1" aria-hidden="true">
              ›
            </span>
            <span>{run_id}</span>
          </nav>
          <h1 className="text-2xl font-semibold">Workflow</h1>
        </div>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{fetchError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!run) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <nav
          className="text-xs text-muted-foreground mb-1"
          aria-label="Localização"
        >
          <Link href="/orchestrator" className="hover:underline">
            Workflows
          </Link>
          <span className="mx-1" aria-hidden="true">
            ›
          </span>
          <span>{run.run_id}</span>
        </nav>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{run.workflow}</h1>
          <StatusBadge status={run.status} />
        </div>
      </div>

      {/* Metadata */}
      <Card>
        <CardHeader>
          <CardTitle>Detalhes da execução</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">Run ID</span>
            <span className="font-mono">{run.run_id}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">
              Workflow
            </span>
            <span>{run.workflow}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">Status</span>
            <StatusBadge status={run.status} />
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">
              Criado em
            </span>
            <span>{new Date(run.created_at).toLocaleString('pt-BR')}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32 shrink-0">
              Atualizado em
            </span>
            <span>{new Date(run.updated_at).toLocaleString('pt-BR')}</span>
          </div>
        </CardContent>
      </Card>

      {/* Trigger Payload */}
      <Card>
        <CardHeader>
          <CardTitle>Payload de disparo</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted rounded-md p-4 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(run.trigger_payload, null, 2)}
          </pre>
        </CardContent>
      </Card>

      {/* Result */}
      <Card>
        <CardHeader>
          <CardTitle>Resultado</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted rounded-md p-4 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(run.result, null, 2)}
          </pre>
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Ações</CardTitle>
        </CardHeader>
        <CardContent>
          <RunActions
            runId={run.run_id}
            status={run.status}
            accessToken={accessToken}
          />
        </CardContent>
      </Card>
    </div>
  );
}
