/**
 * Integration tests — Workspace RLS isolation
 *
 * Validates:
 *   BR-RBAC-002 — Cross-workspace queries prohibited
 *   RLS policies on workspace_members and workspace_api_keys filter by
 *   app.current_workspace_id. A query for workspace A with context set to
 *   workspace B returns zero rows.
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000 and 0001 applied, and a non-superuser role that
 * RLS applies to. If running as superuser, RLS is bypassed — use a
 * restricted role for meaningful tests.
 *
 * Pattern: each test seeds data and asserts visibility changes based on
 * app.current_workspace_id session setting.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('workspace RLS isolation (BR-RBAC-002)', () => {
  let sql: ReturnType<typeof postgres>;

  const WORKSPACE_A_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const WORKSPACE_B_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
  const USER_A_ID = 'aaaaaaaa-0000-0000-0000-000000000011';
  const USER_B_ID = 'bbbbbbbb-0000-0000-0000-000000000011';
  const KEY_HASH_A = 'a'.repeat(64);
  const KEY_HASH_B = 'b'.repeat(64);

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // workspace_members: rows of workspace A are invisible when context = workspace B
  // ---------------------------------------------------------------------------
  it('workspace_members: rows for workspace A invisible when context is workspace B', async () => {
    await sql
      .begin(async (tx) => {
        const ts = Date.now();

        await tx`
          INSERT INTO workspaces (id, slug, name, status) VALUES
            (${WORKSPACE_A_ID}::uuid, ${`rls-ws-a-${ts}`}, 'WS A', 'active'),
            (${WORKSPACE_B_ID}::uuid, ${`rls-ws-b-${ts}`}, 'WS B', 'active')
        `;

        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_A_ID}`;
        await tx`
          INSERT INTO workspace_members (workspace_id, user_id, role)
          VALUES (${WORKSPACE_A_ID}::uuid, ${USER_A_ID}::uuid, 'owner')
        `;

        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_B_ID}`;
        await tx`
          INSERT INTO workspace_members (workspace_id, user_id, role)
          VALUES (${WORKSPACE_B_ID}::uuid, ${USER_B_ID}::uuid, 'owner')
        `;

        // Query workspace_members with context = B — must NOT see workspace A rows
        // BR-RBAC-002: cross-workspace access must return zero rows
        const rows = await tx`
          SELECT * FROM workspace_members WHERE workspace_id = ${WORKSPACE_A_ID}::uuid
        `;
        expect(rows).toHaveLength(0);

        // Query with context = B for own workspace — must see own row
        const ownRows = await tx`
          SELECT * FROM workspace_members WHERE workspace_id = ${WORKSPACE_B_ID}::uuid
        `;
        expect(ownRows).toHaveLength(1);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // workspace_api_keys: rows of workspace A invisible when context = workspace B
  // ---------------------------------------------------------------------------
  it('workspace_api_keys: rows for workspace A invisible when context is workspace B', async () => {
    await sql
      .begin(async (tx) => {
        const ts = Date.now();

        await tx`
          INSERT INTO workspaces (id, slug, name, status) VALUES
            (${WORKSPACE_A_ID}::uuid, ${`rls-apikey-ws-a-${ts}`}, 'WS A', 'active'),
            (${WORKSPACE_B_ID}::uuid, ${`rls-apikey-ws-b-${ts}`}, 'WS B', 'active')
        `;

        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_A_ID}`;
        await tx`
          INSERT INTO workspace_api_keys (workspace_id, name, key_hash)
          VALUES (${WORKSPACE_A_ID}::uuid, 'Key A', ${KEY_HASH_A})
        `;

        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_B_ID}`;
        await tx`
          INSERT INTO workspace_api_keys (workspace_id, name, key_hash)
          VALUES (${WORKSPACE_B_ID}::uuid, 'Key B', ${KEY_HASH_B})
        `;

        // Query with context = B for workspace A key — must see nothing
        // BR-RBAC-002: cross-workspace access must return zero rows
        const rows = await tx`
          SELECT * FROM workspace_api_keys WHERE workspace_id = ${WORKSPACE_A_ID}::uuid
        `;
        expect(rows).toHaveLength(0);

        // Query with context = B for own key — must see own row
        const ownRows = await tx`
          SELECT * FROM workspace_api_keys WHERE workspace_id = ${WORKSPACE_B_ID}::uuid
        `;
        expect(ownRows).toHaveLength(1);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // workspaces: workspace A row invisible when context = workspace B
  // ---------------------------------------------------------------------------
  it('workspaces: workspace A invisible when context is workspace B', async () => {
    await sql
      .begin(async (tx) => {
        const ts = Date.now();

        await tx`
        INSERT INTO workspaces (id, slug, name, status) VALUES
          (${WORKSPACE_A_ID}::uuid, ${`rls-root-ws-a-${ts}`}, 'WS A', 'active'),
          (${WORKSPACE_B_ID}::uuid, ${`rls-root-ws-b-${ts}`}, 'WS B', 'active')
      `;

        // Context = B — should NOT see workspace A
        // BR-RBAC-002: workspace self-isolation
        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_B_ID}`;
        const rows = await tx`
        SELECT * FROM workspaces WHERE id = ${WORKSPACE_A_ID}::uuid
      `;
        expect(rows).toHaveLength(0);

        // Context = A — should see workspace A
        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_A_ID}`;
        const ownRows = await tx`
        SELECT * FROM workspaces WHERE id = ${WORKSPACE_A_ID}::uuid
      `;
        expect(ownRows).toHaveLength(1);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // No context set: query returns zero rows (RLS default-deny)
  // ---------------------------------------------------------------------------
  it('workspace_members: no context set returns zero rows (RLS default-deny)', async () => {
    await sql
      .begin(async (tx) => {
        const ts = Date.now();

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${WORKSPACE_A_ID}::uuid, ${`rls-nocontext-${ts}`}, 'WS A', 'active')
      `;

        await tx`SET LOCAL app.current_workspace_id = ${WORKSPACE_A_ID}`;
        await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${WORKSPACE_A_ID}::uuid, ${USER_A_ID}::uuid, 'owner')
      `;

        // Empty context — current_setting with missing_ok returns ''
        // BR-RBAC-002: empty context matches no workspace_id — zero rows
        await tx`SET LOCAL app.current_workspace_id = ''`;
        const rows = await tx`SELECT * FROM workspace_members`;
        expect(rows).toHaveLength(0);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
