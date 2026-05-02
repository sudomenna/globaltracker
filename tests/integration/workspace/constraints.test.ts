/**
 * Integration tests — Workspace schema constraints
 *
 * Validates:
 *   INV-WORKSPACE-001 — slug globally unique
 *   INV-WORKSPACE-003 — exactly one active owner per workspace (BR-RBAC-001)
 *   INV-WORKSPACE-004 — fx_normalization_currency in allowed ISO 4217 list
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000 and 0001 applied.
 *
 * Pattern: each test uses a transaction that is rolled back after the assertion,
 * keeping the DB clean between tests.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('workspace constraints', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // ---------------------------------------------------------------------------
  // INV-WORKSPACE-001: slug is globally unique (uq_workspaces_slug)
  // ---------------------------------------------------------------------------
  it('INV-WORKSPACE-001: duplicate slug insert fails with unique constraint violation', async () => {
    await sql
      .begin(async (tx) => {
        const slug = `test-slug-${Date.now()}`;

        await tx`
        INSERT INTO workspaces (slug, name, status)
        VALUES (${slug}, 'Workspace A', 'active')
      `;

        await expect(
          tx`
          INSERT INTO workspaces (slug, name, status)
          VALUES (${slug}, 'Workspace B', 'active')
        `,
        ).rejects.toThrow(/unique/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-WORKSPACE-001: slug shorter than 3 chars fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        await expect(
          tx`
          INSERT INTO workspaces (slug, name, status)
          VALUES ('ab', 'Short Slug', 'active')
        `,
        ).rejects.toThrow(/chk_workspaces_slug_length/i);
        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-WORKSPACE-001: slug longer than 64 chars fails check constraint', async () => {
    const longSlug = 'a'.repeat(65);
    await sql
      .begin(async (tx) => {
        await expect(
          tx`
          INSERT INTO workspaces (slug, name, status)
          VALUES (${longSlug}, 'Long Slug', 'active')
        `,
        ).rejects.toThrow(/chk_workspaces_slug_length/i);
        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-WORKSPACE-003 / BR-RBAC-001: at most one active owner per workspace
  // Partial unique index: (workspace_id, role) WHERE role='owner' AND removed_at IS NULL
  // ---------------------------------------------------------------------------
  it('INV-WORKSPACE-003 / BR-RBAC-001: inserting second active owner in same workspace fails', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000001';
        const userId1 = '00000000-0000-0000-0000-000000000011';
        const userId2 = '00000000-0000-0000-0000-000000000012';
        const slug = `owner-test-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${workspaceId}::uuid, ${slug}, 'Owner Test WS', 'active')
        `;

        // First owner — should succeed
        await tx`
          INSERT INTO workspace_members (workspace_id, user_id, role)
          VALUES (${workspaceId}::uuid, ${userId1}::uuid, 'owner')
        `;

        // Second owner in same workspace with removed_at IS NULL — must fail
        // BR-RBAC-001: Owner unique per workspace
        await expect(
          tx`
            INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES (${workspaceId}::uuid, ${userId2}::uuid, 'owner')
          `,
        ).rejects.toThrow(
          /uq_workspace_members_one_active_owner_per_workspace/i,
        );

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-WORKSPACE-003: soft-removed owner does not block a new active owner', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000002';
        const userId1 = '00000000-0000-0000-0000-000000000021';
        const userId2 = '00000000-0000-0000-0000-000000000022';
        const slug = `owner-removed-test-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${workspaceId}::uuid, ${slug}, 'Owner Removed WS', 'active')
        `;

        // First owner — soft-removed (removed_at is set)
        await tx`
          INSERT INTO workspace_members (workspace_id, user_id, role, removed_at)
          VALUES (${workspaceId}::uuid, ${userId1}::uuid, 'owner', now())
        `;

        // Second owner — active (removed_at IS NULL) — must succeed
        // Partial index applies only WHERE removed_at IS NULL
        await expect(
          tx`
            INSERT INTO workspace_members (workspace_id, user_id, role)
            VALUES (${workspaceId}::uuid, ${userId2}::uuid, 'owner')
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // ---------------------------------------------------------------------------
  // INV-WORKSPACE-004: fx_normalization_currency must be in allowed list
  // ---------------------------------------------------------------------------
  it('INV-WORKSPACE-004: inserting workspace with invalid currency XYZ fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const slug = `cur-test-${Date.now()}`;
        await expect(
          tx`
            INSERT INTO workspaces (slug, name, status, fx_normalization_currency)
            VALUES (${slug}, 'Currency Test', 'active', 'XYZ')
          `,
        ).rejects.toThrow(/chk_workspaces_fx_currency/i);
        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-WORKSPACE-004: valid currencies are accepted', async () => {
    const validCurrencies = [
      'BRL',
      'USD',
      'EUR',
      'GBP',
      'ARS',
      'MXN',
      'COP',
      'CLP',
      'PEN',
    ];

    for (const currency of validCurrencies) {
      await sql
        .begin(async (tx) => {
          const slug = `cur-valid-${currency.toLowerCase()}-${Date.now()}`;
          const name = `Currency ${currency}`;
          await expect(
            tx`
            INSERT INTO workspaces (slug, name, status, fx_normalization_currency)
            VALUES (${slug}, ${name}, 'active', ${currency})
          `,
          ).resolves.toBeDefined();
          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    }
  });

  // ---------------------------------------------------------------------------
  // workspace_api_keys: key_hash must be exactly 64 chars
  // ---------------------------------------------------------------------------
  it('workspace_api_keys: key_hash shorter than 64 chars fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000003';
        const slug = `api-key-test-${Date.now()}`;
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${workspaceId}::uuid, ${slug}, 'API Key WS', 'active')
      `;

        await expect(
          tx`
          INSERT INTO workspace_api_keys (workspace_id, name, key_hash)
          VALUES (${workspaceId}::uuid, 'Test Key', 'tooshort')
        `,
        ).rejects.toThrow(/chk_workspace_api_keys_key_hash_length/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('workspace_api_keys: duplicate key_hash globally fails unique constraint', async () => {
    await sql
      .begin(async (tx) => {
        const ws1 = '00000000-0000-0000-0000-000000000004';
        const ws2 = '00000000-0000-0000-0000-000000000005';
        const sharedHash = 'a'.repeat(64);
        const ts = Date.now();

        await tx`SET LOCAL app.current_workspace_id = ${ws1}`;
        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${ws1}::uuid, ${`api-dup-ws1-${ts}`}, 'WS1', 'active')
      `;
        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${ws2}::uuid, ${`api-dup-ws2-${ts}`}, 'WS2', 'active')
      `;

        await tx`
        INSERT INTO workspace_api_keys (workspace_id, name, key_hash)
        VALUES (${ws1}::uuid, 'Key 1', ${sharedHash})
      `;

        await tx`SET LOCAL app.current_workspace_id = ${ws2}`;
        await expect(
          tx`
          INSERT INTO workspace_api_keys (workspace_id, name, key_hash)
          VALUES (${ws2}::uuid, 'Key 2', ${sharedHash})
        `,
        ).rejects.toThrow(/uq_workspace_api_keys_key_hash/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('workspace_members: invalid role value fails check constraint', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000000006';
        const slug = `role-test-${Date.now()}`;
        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
        INSERT INTO workspaces (id, slug, name, status)
        VALUES (${workspaceId}::uuid, ${slug}, 'Role WS', 'active')
      `;

        await expect(
          tx`
          INSERT INTO workspace_members (workspace_id, user_id, role)
          VALUES (${workspaceId}::uuid, gen_random_uuid(), 'superadmin')
        `,
        ).rejects.toThrow(/chk_workspace_members_role/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
