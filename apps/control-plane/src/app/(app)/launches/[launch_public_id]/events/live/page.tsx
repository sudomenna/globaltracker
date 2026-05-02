import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { EventConsole } from './EventConsole';

interface Props {
  params: Promise<{ launch_public_id: string }>;
}

export default async function LiveEventConsolePage({ params }: Props) {
  const { launch_public_id } = await params;

  const supabase = await createSupabaseServer();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect('/login');
  }

  // Resolve workspace_id and launch internal id from the public launch id
  const { data: launch, error } = await supabase
    .from('launches')
    .select('id, workspace_id')
    .eq('public_id', launch_public_id)
    .single();

  if (error || !launch) {
    redirect('/launches');
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Eventos ao vivo</h1>
        <p className="text-sm text-muted-foreground">
          Stream em tempo real de eventos do lançamento
        </p>
      </div>
      <EventConsole
        workspaceId={launch.workspace_id as string}
        launchId={launch.id as string}
        accessToken={session.access_token}
      />
    </div>
  );
}
