/**
 * Integration tests — audit_log schema constraints
 *
 * Validates:
 *   INV-AUDIT-002 — actor_type ∈ AuditActorType ('user', 'system', 'api_key')
 *                   Constraint: chk_audit_log_actor_type
 *   INV-AUDIT-003 — request_context is jsonb nullable (schema-level only;
 *                   PII sanitisation is validated at the app layer in
 *                   tests/unit/audit/sanitize-request-context.test.ts)
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000–0012 applied.
 *
 * Pattern: each test uses a transaction that is rolled back after assertion.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('audit_log — schema constraints', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // -------------------------------------------------------------------------
  // Helper: set up a workspace and RLS context inside a transaction.
  // -------------------------------------------------------------------------
  async function setupWorkspace(
    tx: postgres.TransactionSql,
    workspaceId: string,
    slug: string,
  ): Promise<void> {
    await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;
    await tx`
      INSERT INTO workspaces (id, slug, name, status)
      VALUES (${workspaceId}::uuid, ${slug}, 'Audit Constraint WS', 'active')
    `;
  }

  // -------------------------------------------------------------------------
  // INV-AUDIT-002: actor_type must be in AuditActorType list
  // chk_audit_log_actor_type constraint
  // -------------------------------------------------------------------------
  it('INV-AUDIT-002: actor_type = "bot" fails chk_audit_log_actor_type', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000b00001';
        await setupWorkspace(tx, workspaceId, `audit-inv002-bot-${Date.now()}`);

        await expect(
          tx`
            INSERT INTO audit_log
              (workspace_id, actor_id, actor_type, action, entity_type, entity_id)
            VALUES
              (${workspaceId}::uuid, 'bot-001', 'bot', 'create', 'page', 'page-x')
          `,
        ).rejects.toThrow(/chk_audit_log_actor_type/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-AUDIT-002: actor_type = "admin" fails chk_audit_log_actor_type', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000b00002';
        await setupWorkspace(
          tx,
          workspaceId,
          `audit-inv002-admin-${Date.now()}`,
        );

        await expect(
          tx`
            INSERT INTO audit_log
              (workspace_id, actor_id, actor_type, action, entity_type, entity_id)
            VALUES
              (${workspaceId}::uuid, 'user-001', 'admin', 'update', 'lead', 'lead-x')
          `,
        ).rejects.toThrow(/chk_audit_log_actor_type/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-AUDIT-002: valid actor_type values are accepted', async () => {
    const validActorTypes = ['user', 'system', 'api_key'] as const;

    for (const actorType of validActorTypes) {
      await sql
        .begin(async (tx) => {
          const workspaceId = '00000000-0000-0000-0000-000000b00003';
          await setupWorkspace(
            tx,
            workspaceId,
            `audit-inv002-${actorType}-${Date.now()}`,
          );

          await expect(
            tx`
              INSERT INTO audit_log
                (workspace_id, actor_id, actor_type, action, entity_type, entity_id)
              VALUES
                (${workspaceId}::uuid, 'actor-001', ${actorType}, 'create', 'page', 'page-y')
            `,
          ).resolves.toBeDefined();

          throw new Error('rollback');
        })
        .catch((e) => {
          if ((e as Error).message !== 'rollback') throw e;
        });
    }
  });

  // -------------------------------------------------------------------------
  // INV-AUDIT-003 (schema-level only): request_context is nullable jsonb
  // PII sanitisation validation lives in tests/unit/audit/sanitize-request-context.test.ts
  // -------------------------------------------------------------------------
  it('INV-AUDIT-003 (schema): request_context nullable — NULL is accepted', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000b00004';
        await setupWorkspace(
          tx,
          workspaceId,
          `audit-inv003-null-${Date.now()}`,
        );

        await expect(
          tx`
            INSERT INTO audit_log
              (workspace_id, actor_id, actor_type, action, entity_type, entity_id, request_context)
            VALUES
              (${workspaceId}::uuid, 'system', 'system', 'create', 'lead', 'lead-001', NULL)
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  it('INV-AUDIT-003 (schema): request_context jsonb — structured value is accepted', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000b00005';
        await setupWorkspace(
          tx,
          workspaceId,
          `audit-inv003-json-${Date.now()}`,
        );

        const context = JSON.stringify({
          ip_hash:
            'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
          ua_hash:
            '11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd',
          request_id: 'req-abc-123',
        });

        await expect(
          tx`
            INSERT INTO audit_log
              (workspace_id, actor_id, actor_type, action, entity_type, entity_id, request_context)
            VALUES
              (${workspaceId}::uuid, 'system', 'system', 'create', 'lead', 'lead-002', ${context}::jsonb)
          `,
        ).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
