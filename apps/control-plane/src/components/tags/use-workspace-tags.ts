'use client';

import { useCallback, useEffect, useState } from 'react';

const EDGE = process.env.NEXT_PUBLIC_EDGE_WORKER_URL ?? 'http://localhost:8787';

export interface WorkspaceTag {
  id: string;
  workspace_id: string;
  name: string;
  color: string | null;
  description: string | null;
  created_by: string;
  created_at: string;
  archived_at: string | null;
  lead_count?: number;
}

interface UseWorkspaceTagsOptions {
  includeArchived?: boolean;
  withCount?: boolean;
}

interface UseWorkspaceTagsResult {
  tags: WorkspaceTag[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Lê access_token do cookie sb-*-auth-token (mesmo padrão usado em
 * apps/control-plane/src/app/(app)/contatos/page.tsx).
 */
function readAccessToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/sb-[^=]+-auth-token=([^;]+)/);
  if (!match) return '';
  try {
    let raw = match[1];
    if (raw?.startsWith('base64-')) {
      raw = atob(raw.slice(7));
    } else if (raw) {
      raw = decodeURIComponent(raw);
    }
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed?.access_token ?? '';
  } catch {
    return '';
  }
}

export function useWorkspaceTags(
  opts?: UseWorkspaceTagsOptions,
): UseWorkspaceTagsResult {
  const { includeArchived = false, withCount = false } = opts ?? {};
  const [tags, setTags] = useState<WorkspaceTag[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetcher = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = readAccessToken();
      if (!token) {
        // Sem token ainda — provavelmente cookie não montou; mantenha loading
        // até a próxima reload(). Não emitimos erro para evitar flash no UI.
        setTags([]);
        return;
      }
      const params = new URLSearchParams();
      if (includeArchived) params.set('include_archived', 'true');
      if (withCount) params.set('with_count', 'true');
      const url = `${EDGE}/v1/workspace-tags${
        params.toString() ? `?${params.toString()}` : ''
      }`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setTags([]);
        return;
      }
      // Edge devolve camelCase (Drizzle .$inferSelect). Normalizamos para
      // snake_case esperado pela UI.
      type ApiTag = {
        id: string;
        workspaceId?: string;
        workspace_id?: string;
        name: string;
        color: string | null;
        description: string | null;
        createdBy?: string;
        created_by?: string;
        createdAt?: string;
        created_at?: string;
        archivedAt?: string | null;
        archived_at?: string | null;
        leadCount?: number;
        lead_count?: number;
      };
      const body = (await res.json()) as { tags?: ApiTag[]; items?: ApiTag[] };
      const raw = body.tags ?? body.items ?? [];
      const normalized: WorkspaceTag[] = raw.map((t) => ({
        id: t.id,
        workspace_id: t.workspace_id ?? t.workspaceId ?? '',
        name: t.name,
        color: t.color,
        description: t.description,
        created_by: t.created_by ?? t.createdBy ?? '',
        created_at: t.created_at ?? t.createdAt ?? '',
        archived_at: t.archived_at ?? t.archivedAt ?? null,
        lead_count: t.lead_count ?? t.leadCount,
      }));
      setTags(normalized);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
      setTags([]);
    } finally {
      setLoading(false);
    }
  }, [includeArchived, withCount]);

  useEffect(() => {
    void fetcher();
  }, [fetcher]);

  return { tags, loading, error, reload: fetcher };
}
