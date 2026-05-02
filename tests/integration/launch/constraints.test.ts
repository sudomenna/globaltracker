/**
 * Integration tests — Launch schema constraints
 *
 * Validates:
 *   INV-LAUNCH-001 — (workspace_id, public_id) unique per workspace
 *   INV-LAUNCH-002 — status='archived' is a valid value (ingest rejection is Edge concern)
 *   chk_launches_status — invalid status values are rejected
 *   chk_launches_public_id_length — public_id length is enforced (3..64)
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000, 0001, and 0002 applied.
 *
 * Pattern: each test uses a transaction that is rolled back after the assertion,
 * keeping the DB clean between tests.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a workspace and returns its id. Must be called inside a transaction.
 */
async function insertWorkspace(
  tx: postgres.TransactionSql,
  id: string,
  slugSuffix: string,
): Promise<void> {
  await tx`SET LOCAL app.current_workspace_id = ${id}`;
  await tx`
    INSERT INTO workspaces (id, slug, name, status)
    VALUES (${id}::uuid, ${`launch-test-ws-${slugSuffix}`}, 'Launch Test WS', 'active')
  `;
}

/**
 * Inserts a launch inside a transaction. Requires workspace to already exist.
 */
async function insertLaunch(
  tx: postgres.TransactionSql,
  workspaceId: string,
  publicId: string,
  status = 'draft',
): Promise<void> {
  await tx`
    INSERT INTO launches (workspace_id, public_id, name, status)
    VALUES (${workspaceId}::uuid, ${publicId}, 'Test Launch', ${status})
  `;
}

describeIfDb('launch constraints', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // INV-LAUNCH-001: (workspace_id, public_id) unique per workspace
  // Constraint: uq_launches_workspace_public_id
  // ---------------------------------------------------------------------------
  it('INV-LAUNCH-001: duplicate (workspace_id, public_id) insert fails with unique constraint violation', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000001';
        await insertWorkspace(tx, wsId, `inv001-dup-${Date.now()}`);

        await insertLaunch(tx, wsId, 'my-launch');

        // Second insert with same workspace_id + public_id must fail
        // INV-LAUNCH-001: public_id is unique per workspace
        await expect(insertLaunch(tx, wsId, 'my-launch')).rejects.toThrow(
          /uq_launches_workspace_public_id/i,
        );

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-LAUNCH-001: same public_id in different workspaces is allowed', async () => {
    await sql
      .begin(async (tx) => {
        const wsId1 = '00000000-0000-0000-0001-000000000002';
        const wsId2 = '00000000-0000-0000-0001-000000000003';
        const ts = Date.now();

        await tx`SET LOCAL app.current_workspace_id = ${wsId1}`;
        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${wsId1}::uuid, ${`launch-ws1-${ts}`}, 'WS1', 'active')
        `;
        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${wsId2}::uuid, ${`launch-ws2-${ts}`}, 'WS2', 'active')
        `;

        await insertLaunch(tx, wsId1, 'shared-slug');
        // Same public_id in a different workspace must succeed
        await expect(
          insertLaunch(tx, wsId2, 'shared-slug'),
        ).resolves.toBeUndefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-LAUNCH-002: status='archived' is a valid DB value
  // (Ingest rejection is enforced at Edge via requireActiveLaunch — not a DB constraint)
  // ---------------------------------------------------------------------------
  it('INV-LAUNCH-002: status=archived is accepted by chk_launches_status', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000004';
        await insertWorkspace(tx, wsId, `inv002-${Date.now()}`);

        // 'archived' must not be rejected by the DB check constraint
        await expect(
          insertLaunch(tx, wsId, 'archived-launch', 'archived'),
        ).resolves.toBeUndefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // chk_launches_status: invalid status is rejected
  // ---------------------------------------------------------------------------
  it('chk_launches_status: invalid status value is rejected', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000005';
        await insertWorkspace(tx, wsId, `inv-status-${Date.now()}`);

        await expect(
          insertLaunch(tx, wsId, 'bad-status-launch', 'deleted'),
        ).rejects.toThrow(/chk_launches_status/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('chk_launches_status: all valid status values are accepted', async () => {
    const validStatuses = ['draft', 'configuring', 'live', 'ended', 'archived'];

    for (const status of validStatuses) {
      await sql
        .begin(async (tx) => {
          const wsId = '00000000-0000-0000-0001-000000000006';
          await insertWorkspace(tx, wsId, `status-${status}-${Date.now()}`);

          await expect(
            insertLaunch(tx, wsId, `launch-${status}`, status),
          ).resolves.toBeUndefined();

          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    }
  });

  // ---------------------------------------------------------------------------
  // chk_launches_public_id_length: public_id length between 3 and 64
  // ---------------------------------------------------------------------------
  it('chk_launches_public_id_length: public_id shorter than 3 chars is rejected', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000007';
        await insertWorkspace(tx, wsId, `pid-short-${Date.now()}`);

        await expect(insertLaunch(tx, wsId, 'ab')).rejects.toThrow(
          /chk_launches_public_id_length/i,
        );

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('chk_launches_public_id_length: public_id longer than 64 chars is rejected', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000008';
        await insertWorkspace(tx, wsId, `pid-long-${Date.now()}`);
        const longId = 'a'.repeat(65);

        await expect(insertLaunch(tx, wsId, longId)).rejects.toThrow(
          /chk_launches_public_id_length/i,
        );

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('chk_launches_public_id_length: public_id of exactly 3 chars is accepted', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000009';
        await insertWorkspace(tx, wsId, `pid-min-${Date.now()}`);

        await expect(insertLaunch(tx, wsId, 'abc')).resolves.toBeUndefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('chk_launches_public_id_length: public_id of exactly 64 chars is accepted', async () => {
    await sql
      .begin(async (tx) => {
        const wsId = '00000000-0000-0000-0001-000000000010';
        await insertWorkspace(tx, wsId, `pid-max-${Date.now()}`);
        const maxId = 'a'.repeat(64);

        await expect(insertLaunch(tx, wsId, maxId)).resolves.toBeUndefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
