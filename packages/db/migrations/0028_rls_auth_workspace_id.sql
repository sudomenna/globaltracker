-- Fix RLS: allow reads via Supabase JWT (auth.uid → workspace_members) in addition to app.current_workspace_id GUC.
-- Edge worker continues to work (postgres role bypasses RLS anyway).
-- Control-plane Server Components now work via authenticated role.

-- 1. SECURITY DEFINER helper to look up the user's workspace bypassing RLS
CREATE OR REPLACE FUNCTION public.auth_workspace_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT workspace_id
  FROM public.workspace_members
  WHERE user_id = auth.uid()
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.auth_workspace_id() TO authenticated, anon;

-- 2. workspace_members — user can always read their own membership
DROP POLICY IF EXISTS workspace_members_workspace_isolation ON public.workspace_members;
CREATE POLICY workspace_members_workspace_isolation ON public.workspace_members
FOR ALL
USING (
  workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  OR user_id = auth.uid()
)
WITH CHECK (
  workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  OR user_id = auth.uid()
);

-- 3. workspaces — readable if user belongs to it
DROP POLICY IF EXISTS workspaces_self_isolation ON public.workspaces;
CREATE POLICY workspaces_self_isolation ON public.workspaces
FOR ALL
USING (
  id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  OR id = public.auth_workspace_id()
)
WITH CHECK (
  id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  OR id = public.auth_workspace_id()
);

-- 4. All 29 *_workspace_isolation policies — accept either GUC or auth-derived workspace
DO $$
DECLARE
  r record;
  pred text;
BEGIN
  pred := '(workspace_id = NULLIF(current_setting(''app.current_workspace_id'', true), '''')::uuid OR workspace_id = public.auth_workspace_id())';
  FOR r IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE '%_workspace_isolation'
      AND tablename <> 'workspace_members'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING %s WITH CHECK %s',
      r.policyname, r.tablename, pred, pred
    );
  END LOOP;
END $$;
