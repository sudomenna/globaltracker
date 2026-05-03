import { createSupabaseBrowser } from '@/lib/supabase-browser';
import useSWR from 'swr';

interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
}

async function fetchWorkspace(): Promise<WorkspaceInfo | null> {
  const supabase = createSupabaseBrowser();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces(id, name, slug)')
    .eq('user_id', user.id)
    .is('removed_at', null)
    .order('joined_at', { ascending: true })
    .limit(1)
    .single();

  if (!data) return null;
  const ws = data.workspaces as { id: string; name: string; slug: string } | null;
  return ws ?? null;
}

export function useWorkspace() {
  const { data } = useSWR<WorkspaceInfo | null>('workspace-info', fetchWorkspace);
  return { workspace: data ?? null };
}
