import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function SarPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Privacy</h1>
        <p className="text-sm text-muted-foreground">
          Gerencie solicitações de acesso e exclusão de dados (SAR / LGPD)
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Solicitações de Titulares (SAR)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Implementação completa em breve.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Aqui você poderá processar pedidos de acesso, portabilidade e
            exclusão de dados de leads conforme a LGPD.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
