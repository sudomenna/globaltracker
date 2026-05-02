import { createSupabaseServer } from '@/lib/supabase-server';
import { IntegrationsListClient } from './integrations-list-client';

export default async function IntegrationsPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const role = (user?.app_metadata?.role as string | undefined) ?? 'marketer';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrações</h1>
        <p className="text-sm text-muted-foreground">
          Configure e monitore suas integrações com Meta, Google Ads e GA4
        </p>
      </div>
      <IntegrationsListClient role={role} />
    </div>
  );
}
