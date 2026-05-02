// Leads — placeholder
// Busca + detalhe com timeline será implementado em T-6-014

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function LeadsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Busque e analise seus leads
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Busca de Leads</CardTitle>
          <CardDescription>Implementação completa em T-6-014</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Use a busca para encontrar leads por e-mail ou ID público.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
