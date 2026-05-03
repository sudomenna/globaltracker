import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function WorkspaceSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Configurações</h1>
        <p className="text-sm text-muted-foreground">
          Gerencie seu workspace, membros e preferências
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Implementação completa em breve.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Aqui você poderá editar o nome do workspace, gerenciar membros e
            configurar permissões.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
