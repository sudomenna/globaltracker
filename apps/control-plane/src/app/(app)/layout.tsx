import { AppHeader } from '@/components/app-header';
import { SidebarNav } from '@/components/sidebar-nav';
import { createSupabaseServer } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';

async function getWorkspaceName(userId: string): Promise<string | null> {
  // Service role bypasses RLS — safe server-side only
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data } = await supabase
    .from('workspace_members')
    .select('workspaces(name)')
    .eq('user_id', userId)
    .is('removed_at', null)
    .order('joined_at', { ascending: true })
    .limit(1)
    .single();

  if (!data) return null;
  const ws = data.workspaces as { name: string } | null;
  return ws?.name ?? null;
}

export default async function AppLayout({
  children,
}: { children: React.ReactNode }) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const workspaceName = await getWorkspaceName(user.id);

  return (
    <div className="flex h-screen overflow-hidden">
      <SidebarNav />
      <div className="flex flex-col flex-1 overflow-hidden">
        <AppHeader workspaceName={workspaceName} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
