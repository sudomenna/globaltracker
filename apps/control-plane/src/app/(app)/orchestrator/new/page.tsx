// T-7-009 — New Workflow page (Server Component wrapper + Client form)

import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { NewWorkflowForm } from './new-workflow-form';

export default async function NewWorkflowPage() {
  const supabase = await createSupabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Novo Workflow</h1>
        <p className="text-sm text-muted-foreground">
          Dispare um workflow de automação
        </p>
      </div>
      <NewWorkflowForm accessToken={session.access_token} />
    </div>
  );
}
