import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { RecoveryClient } from './recovery-client';

export default async function RecoveryPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // BR-RBAC-001: mutações em /v1/recovery/* exigem owner/admin — UI esconde
  // criação/edição para outros roles (leitura liberada).
  const role = (user.app_metadata?.role as string | undefined) ?? 'marketer';
  const canEdit = role === 'owner' || role === 'admin';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Recovery</h1>
        <p className="text-sm text-muted-foreground">
          Fluxos de recuperação de carrinho abandonado por lançamento e produto.
        </p>
      </div>
      <RecoveryClient canEdit={canEdit} />
    </div>
  );
}
