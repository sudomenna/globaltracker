/**
 * Integration tests — audit_log append-only enforcement
 *
 * Validates:
 *   INV-AUDIT-001 — audit_log rejects UPDATE and DELETE (BR-AUDIT-001, AUTHZ-004)
 *
 * Both triggers are tested:
 *   trg_audit_log_before_update_block
 *   trg_audit_log_before_delete_block
 *
 * Requires: DATABASE_URL env var pointing to a Postgres 15+ instance
 * with migrations 0000–0012 applied.
 *
 * Pattern: each test inserts a row inside a transaction, exercises the blocked
 * operation, asserts the exception message, and rolls back.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// biome-ignore lint/complexity/useLiteralKeys: noUncheckedIndexedAccess requires string access here
const DATABASE_URL = process.env['DATABASE_URL'];

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('audit_log — INV-AUDIT-001: append-only enforcement', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL not set');
    sql = postgres(DATABASE_URL, { prepare: false });
  });

  afterAll(async () => {
    await sql.end();
  });

  // -------------------------------------------------------------------------
  // Helper: insert a minimal valid audit_log row and return its id.
  // Must be called inside an active transaction (tx).
  // -------------------------------------------------------------------------
  async function insertAuditRow(
    tx: postgres.TransactionSql,
    workspaceId: string,
  ): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO audit_log
        (workspace_id, actor_id, actor_type, action, entity_type, entity_id)
      VALUES
        (${workspaceId}::uuid, 'system', 'system', 'create', 'page', 'page-001')
      RETURNING id
    `;
    const first = rows[0];
    if (!first) throw new Error('INSERT did not return a row');
    return first.id;
  }

  // -------------------------------------------------------------------------
  // INV-AUDIT-001 (UPDATE): trg_audit_log_before_update_block fires and
  // raises "audit_log is append-only: UPDATE is not allowed"
  // BR-AUDIT-001, AUTHZ-004
  // -------------------------------------------------------------------------
  it('INV-AUDIT-001: UPDATE on audit_log raises append-only exception', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000a00001';
        const slug = `audit-upd-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${workspaceId}::uuid, ${slug}, 'Audit Update WS', 'active')
        `;

        const rowId = await insertAuditRow(tx, workspaceId);

        // BR-AUDIT-001: UPDATE must be rejected by trigger
        await expect(
          tx`UPDATE audit_log SET action = 'tampered' WHERE id = ${rowId}::uuid`,
        ).rejects.toThrow(/audit_log is append-only/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // -------------------------------------------------------------------------
  // INV-AUDIT-001 (DELETE): trg_audit_log_before_delete_block fires and
  // raises "audit_log is append-only: DELETE is not allowed"
  // BR-AUDIT-001, AUTHZ-004
  // -------------------------------------------------------------------------
  it('INV-AUDIT-001: DELETE on audit_log raises append-only exception', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000a00002';
        const slug = `audit-del-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${workspaceId}::uuid, ${slug}, 'Audit Delete WS', 'active')
        `;

        const rowId = await insertAuditRow(tx, workspaceId);

        // BR-AUDIT-001: DELETE must be rejected by trigger
        await expect(
          tx`DELETE FROM audit_log WHERE id = ${rowId}::uuid`,
        ).rejects.toThrow(/audit_log is append-only/i);

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });

  // -------------------------------------------------------------------------
  // Positive: INSERT succeeds (baseline sanity check)
  // -------------------------------------------------------------------------
  it('audit_log: valid INSERT succeeds', async () => {
    await sql
      .begin(async (tx) => {
        const workspaceId = '00000000-0000-0000-0000-000000a00003';
        const slug = `audit-ins-${Date.now()}`;

        await tx`SET LOCAL app.current_workspace_id = ${workspaceId}`;

        await tx`
          INSERT INTO workspaces (id, slug, name, status)
          VALUES (${workspaceId}::uuid, ${slug}, 'Audit Insert WS', 'active')
        `;

        await expect(insertAuditRow(tx, workspaceId)).resolves.toBeDefined();

        throw new Error('rollback');
      })
      .catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });
  });
});
