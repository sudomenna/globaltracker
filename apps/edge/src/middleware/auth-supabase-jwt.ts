/**
 * auth-supabase-jwt.ts — Hono middleware that verifies Supabase user JWTs.
 *
 * Supabase emits JWTs signed with ES256 (asymmetric keys, JWKS-based) in modern
 * projects. This middleware:
 *   1. Reads `Authorization: Bearer <token>`.
 *   2. Verifies via `jose.createRemoteJWKSet` against the project JWKS endpoint.
 *   3. Extracts `sub` (user_id) and `app_metadata.role` from the verified payload.
 *   4. Looks up `workspace_id` via workspace_members (or trusts a header in dev).
 *   5. Sets context vars: `user_id`, `workspace_id`, `role`.
 *
 * Failure modes:
 *   - missing/invalid Authorization header → 401 unauthorized (only when `required:true`)
 *   - JWT verification failure → 401
 *   - user has no workspace_member row → 403 forbidden_no_workspace
 *
 * BR-RBAC-001: workspace_id resolved from membership lookup, never from request body.
 *
 * NOTE: For dev mode (no auth header), falls back to DEV_WORKSPACE_ID + 'owner'
 * role to keep compatibility with the existing tests/scripts. Controlled by env.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';

// ---------------------------------------------------------------------------
// JWKS cache — module-scoped so a single worker instance reuses the JWKS fetch
// across requests within its lifetime. Each Worker isolate gets its own cache.
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string) {
  let cached = jwksCache.get(supabaseUrl);
  if (!cached) {
    const url = new URL('/auth/v1/.well-known/jwks.json', supabaseUrl);
    cached = createRemoteJWKSet(url, {
      // Default cooldown is 30s; keep stable.
    });
    jwksCache.set(supabaseUrl, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupabaseAuthEnv = {
  /** e.g. https://<ref>.supabase.co */
  SUPABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  ENVIRONMENT?: string;
};

export type AuthContext = {
  user_id?: string;
  workspace_id?: string;
  role?: WorkspaceRole;
};

export type LookupWorkspaceMemberFn = (
  userId: string,
) => Promise<{ workspace_id: string; role: WorkspaceRole } | null>;

export type AuthMiddlewareOpts = {
  /** Required mode rejects requests without a valid JWT (401). */
  required?: boolean;
  /** Lookup user → workspace_member. Required for required-mode requests. */
  lookupMember?: LookupWorkspaceMemberFn;
  /** Optional override for SUPABASE_URL when env doesn't carry it. */
  supabaseUrl?: string;
};

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function supabaseJwtMiddleware<E extends { Bindings: SupabaseAuthEnv }>(
  opts: AuthMiddlewareOpts = {},
): MiddlewareHandler<E> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const bearer = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    // Dev fallback: no token + dev workspace configured → owner role.
    // Keeps unit-test scripts and curl smoke flows working without forcing JWT.
    if (!bearer) {
      if (opts.required) {
        return c.json({ code: 'unauthorized' }, 401);
      }
      if (c.env.DEV_WORKSPACE_ID) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c.set as any)('user_id', 'dev');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c.set as any)('workspace_id', c.env.DEV_WORKSPACE_ID);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c.set as any)('role', 'owner' as WorkspaceRole);
      }
      await next();
      return;
    }

    const supabaseUrl = opts.supabaseUrl ?? c.env.SUPABASE_URL;
    if (!supabaseUrl) {
      // Misconfiguration — refuse rather than guessing.
      return c.json({ code: 'auth_misconfigured', hint: 'SUPABASE_URL' }, 500);
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(bearer, getJwks(supabaseUrl), {
        // Supabase's iss is the project URL + /auth/v1; we don't pin it strictly
        // because future host moves shouldn't break this. JWKS verification
        // already binds to the project.
      });
      payload = verified.payload;
    } catch {
      return c.json({ code: 'invalid_token' }, 401);
    }

    const userId = typeof payload.sub === 'string' ? payload.sub : null;
    if (!userId) {
      return c.json({ code: 'invalid_token', hint: 'no_sub' }, 401);
    }

    // Role resolution:
    // workspace_members é a fonte canônica (mudanças de role refletem imediato,
    // sem esperar refresh de JWT). app_metadata.role do JWT é fallback quando o
    // lookup de membership não estiver disponível (tests, dev offline).
    let role: WorkspaceRole | null = null;
    let workspaceId: string | null = null;

    if (opts.lookupMember) {
      const member = await opts.lookupMember(userId);
      if (member) {
        workspaceId = member.workspace_id;
        role = member.role;
      }
    }

    if (!role) {
      const appMeta = (payload as { app_metadata?: { role?: unknown } }).app_metadata;
      if (
        appMeta &&
        typeof appMeta === 'object' &&
        typeof appMeta.role === 'string' &&
        isValidRole(appMeta.role)
      ) {
        role = appMeta.role;
      }
    }

    if (!workspaceId) {
      // No membership found and no dev fallback — treat as forbidden.
      return c.json({ code: 'forbidden_no_workspace' }, 403);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.set as any)('user_id', userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.set as any)('workspace_id', workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (role) (c.set as any)('role', role);

    await next();
  };
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

export function getRoleFromContext(c: Context): WorkspaceRole | null {
  const r = c.get('role');
  return isValidRole(r) ? r : null;
}
