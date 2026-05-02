// Lançamentos — placeholder
// CRUD completo será implementado em T-6-012

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function LaunchesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Lançamentos</h1>
        <p className="text-sm text-muted-foreground">
          Gerencie seus lançamentos
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lista de Lançamentos</CardTitle>
          <CardDescription>Implementação completa em T-6-012</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Nenhum lançamento cadastrado ainda.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
