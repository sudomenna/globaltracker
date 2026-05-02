// Orchestrator — list page (placeholder until T-7-010 adds list endpoint)
// T-7-009

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import Link from 'next/link';

export default function OrchestratorPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Automações de lançamento e provisionamento
          </p>
        </div>
        <Button asChild>
          <Link href="/orchestrator/new">Novo Workflow</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Histórico de execuções</CardTitle>
          <CardDescription>
            Listagem completa disponível em breve
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Para acompanhar um workflow, acesse{' '}
            <code>/orchestrator/[run_id]</code> com o ID retornado ao criar.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
