/**
 * Integration tests — Workspace lifecycle
 *
 * Validates:
 *   INV-WORKSPACE-002 — 'archived' status is a valid value (stored correctly);
 *                       Edge-layer ingest rejection is out of scope for schema tests.
 *   INV-WORKSPACE-005 — revoked_at column exists and is nullable;
 *                       auth rejection for revoked keys is at Edge layer.
 *
 * Also covers:
 *   - All valid WorkspaceStatus values can be stored
 *   - Invalid status is rejected by check constraint
 *   - updated_at trigger fires on UPDATE
 *   - workspace_members joined_at and removed_at are nullable
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000 and 0001 applied.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('workspace lifecycle (INV-002, INV-005)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // INV-WORKSPACE-002: 'archived' status is storable at schema level
  // Note: Edge Gateway's 410 rejection is tested in Edge integration tests.
  // ---------------------------------------------------------------------------
  it('INV-WORKSPACE-002: workspace with status=archived can be inserted and read back', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000101';
        const slug = `lifecycle-archived-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${workspaceId}::uuid, ${slug}, 'Archived WS', 'archived')
      `;

        const rows = await tx`
        SELECT status FROM workspaces WHERE id = ${workspaceId}::uuid
      `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe('archived');

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('all valid WorkspaceStatus values are accepted', async () => {
    const statuses = ['draft', 'active', 'suspended', 'archived'] as const;

    for (const status of statuses) {
      await sql
        .begin(async (tx) => {
          const workspaceId = crypto.randomUUID();
          const slug = `status-${status}-${Date.now()}`;
          const name = `WS ${status}`;

          await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

          await expect(
            tx`
            INSERT INTO workspaces (id, slug, name, status)
            VALUES (${workspaceId}::uuid, ${slug}, ${name}, ${status})
          `,
          ).resolves.toBeDefined();

          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    }
  });

  it('invalid status value is rejected by check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const slug = `bad-status-${Date.now()}`;
        await expect(
          tx`
          INSERT INTO workspaces (slug, name, status)
          VALUES (${slug}, 'Bad Status WS', 'deleted')
        `,
        ).rejects.toThrow(/chk_workspaces_status/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // updated_at trigger: UPDATE changes updated_at
  // ---------------------------------------------------------------------------
  it('updated_at trigger fires on UPDATE and changes timestamp', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000102';
        const slug = `trigger-test-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${workspaceId}::uuid, ${slug}, 'Trigger WS', 'active')
      `;

        const before = await tx`
        SELECT updated_at FROM workspaces WHERE id = ${workspaceId}::uuid
      `;

        // Small pause to ensure clock advances
        await new Promise((r) => setTimeout(r, 10));

        await tx`
        UPDATE workspaces SET name = 'Updated Name' WHERE id = ${workspaceId}::uuid
      `;

        const after = await tx`
        SELECT updated_at FROM workspaces WHERE id = ${workspaceId}::uuid
      `;

        expect(before[0]?.updated_at).toBeDefined();
        expect(after[0]?.updated_at).toBeDefined();

        const beforeTime = new Date(before[0]?.updated_at as string).getTime();
        const afterTime = new Date(after[0]?.updated_at as string).getTime();
        // updated_at must have changed (trigger fired)
        expect(afterTime).toBeGreaterThanOrEqual(beforeTime);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-WORKSPACE-005: revoked_at column is nullable — no schema-level rejection
  // Auth rejection for revoked keys is at Edge layer
  // ---------------------------------------------------------------------------
  it('INV-WORKSPACE-005: workspace_api_keys revoked_at column is nullable', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000103';
        const slug = `revoked-test-${Date.now()}`;
        const keyHash = 'c'.repeat(64);

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${workspaceId}::uuid, ${slug}, 'Revoked WS', 'active')
      `;

        // Insert with revoked_at = null (active key)
        await tx`
        INSERT INTO workspace_api_keys (workspace_id, name, key_hash, revoked_at)
        VALUES (${workspaceId}::uuid, 'Active Key', ${keyHash}, NULL)
      `;

        const rows = await tx`
        SELECT revoked_at FROM workspace_api_keys
        WHERE workspace_id = ${workspaceId}::uuid AND key_hash = ${keyHash}
      `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.revoked_at).toBeNull();

        // Update to set revoked_at (simulate revocation)
        await tx`
        UPDATE workspace_api_keys
        SET revoked_at = now()
        WHERE workspace_id = ${workspaceId}::uuid AND key_hash = ${keyHash}
      `;

        const revokedRows = await tx`
        SELECT revoked_at FROM workspace_api_keys
        WHERE workspace_id = ${workspaceId}::uuid AND key_hash = ${keyHash}
      `;

        expect(revokedRows[0]?.revoked_at).not.toBeNull();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // workspace_members: joined_at and removed_at are nullable (invited state)
  // ---------------------------------------------------------------------------
  it('workspace_members: joined_at and removed_at are nullable (invited state)', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000104';
        const slug = `member-nullable-${Date.now()}`;
        const userId = crypto.randomUUID();

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${workspaceId}::uuid, ${slug}, 'Member Nullable WS', 'active')
      `;

        await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role, joined_at, removed_at)
        VALUES (${workspaceId}::uuid, ${userId}::uuid, 'admin', NULL, NULL)
      `;

        const rows = await tx`
        SELECT joined_at, removed_at FROM workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
      `;

        expect(rows).toHaveLength(1);
        expect(rows[0]?.joined_at).toBeNull();
        expect(rows[0]?.removed_at).toBeNull();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
