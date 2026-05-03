import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function AudiencesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audiences</h1>
        <p className="text-sm text-muted-foreground">
          Sincronize audiências com Meta Custom Audiences e Google Customer
          Match
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sincronização de Audiências</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Implementação completa em breve.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Aqui você poderá criar e sincronizar segmentos de leads com
            plataformas de mídia paga.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
