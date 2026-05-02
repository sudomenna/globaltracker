import { AppHeader } from '@/components/app-header';
import { SidebarNav } from '@/components/sidebar-nav';
import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';

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

  return (
    <div className="flex h-screen overflow-hidden">
      <SidebarNav />
      <div className="flex flex-col flex-1 overflow-hidden">
        <AppHeader />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
