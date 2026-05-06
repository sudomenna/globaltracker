import { createSupabaseServer } from '@/lib/supabase-server';
import { SendflowDetailClient } from './sendflow-detail-client';

export default async function SendflowIntegrationPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const role = (user?.app_metadata?.role as string | undefined) ?? 'marketer';
  // AUTHZ: only operator/admin/owner may edit credentials/mappings
  const canEdit = ['operator', 'admin', 'owner'].includes(role);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">SendFlow</h1>
        <p className="text-sm text-muted-foreground">
          Webhook inbound do SendFlow — gerencia entradas em grupos de WhatsApp
          e mapeia para stages do funil.
        </p>
      </div>

      <SendflowDetailClient canEdit={canEdit} />
    </div>
  );
}
