import { createSupabaseServer } from '@/lib/supabase-server';
import { GoogleAdsClient } from './google-ads-client';

export default async function GoogleAdsIntegrationPage() {
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
        <h1 className="text-2xl font-semibold">Google Ads</h1>
        <p className="text-sm text-muted-foreground">
          Integração com Google Ads — upload de conversões e enhanced conversions
          via OAuth.
        </p>
      </div>

      <GoogleAdsClient canEdit={canEdit} />
    </div>
  );
}
