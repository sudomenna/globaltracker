import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { ProductsListClient } from './products-list-client';

export default async function ProductsPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // BR-RBAC-001: PATCH /v1/products requer owner/admin — UI esconde edit para outros roles.
  const role = (user.app_metadata?.role as string | undefined) ?? 'marketer';
  const canEdit = role === 'owner' || role === 'admin';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Produtos</h1>
        <p className="text-sm text-muted-foreground">
          Catálogo de produtos cadastrados via webhooks de compra
        </p>
      </div>
      <ProductsListClient canEdit={canEdit} />
    </div>
  );
}
