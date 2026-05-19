/**
 * Unit tests — lead-tags.ts (bulk + unset helpers).
 *
 * T-TAGS-008 (test author) cobrindo helpers adicionados em T-TAGS-002.
 *
 * Mocked DB (`db.execute`); verifies:
 *   - INV-LEAD-TAG-001: ON CONFLICT DO NOTHING (re-aplicar mesma tag = noop, count=1).
 *   - bulkApplyLeadTagsByIds: cross-product correto, idempotência, casos vazios.
 *   - bulkUnsetLeadTagsByIds: remove apenas a interseção esperada.
 *   - unsetLeadTag: removed=false quando tag não existe.
 *
 * O helper retorna contadores derivados de `result.length` (rows do RETURNING),
 * portanto o mock devolve arrays de tamanho controlado para simular cada cenário.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  bulkApplyLeadTagsByIds,
  bulkUnsetLeadTagsByIds,
  unsetLeadTag,
} from '../../../apps/edge/src/lib/lead-tags';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const LEAD_A = '22222222-2222-2222-2222-222222222222';
const LEAD_B = '33333333-3333-3333-3333-333333333333';

/**
 * Mock factory: `db.execute` resolves with `returningRows` (default `[]`) or
 * throws. Each call increments `callCount` so tests can assert sequence.
 */
function makeMockDb(opts?: {
  returningRows?: unknown[];
  throwError?: Error | string;
}) {
  const executeSpy = vi.fn(async () => {
    if (opts?.throwError !== undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- testa não-Error
      throw opts.throwError;
    }
    return opts?.returningRows ?? [];
  });

  const db = { execute: executeSpy } as unknown as Parameters<
    typeof unsetLeadTag
  >[0]['db'];

  return { db, executeSpy };
}

// ---------------------------------------------------------------------------
// unsetLeadTag
// ---------------------------------------------------------------------------

describe('unsetLeadTag (T-TAGS-002, INV-LEAD-TAG-001, BR-IDENTITY)', () => {
  it('returns ok=true, removed=true when DELETE affects a row', async () => {
    // RETURNING id with one row → removed=true.
    const { db, executeSpy } = makeMockDb({ returningRows: [{ id: 'tag-row-1' }] });

    const result = await unsetLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_A,
      tagName: 'wpp_joined',
    });

    expect(result).toEqual({ ok: true, removed: true });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('returns ok=true, removed=false when tag does not exist (idempotent)', async () => {
    // RETURNING id with zero rows → removed=false; NOT an error.
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    const result = await unsetLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_A,
      tagName: 'never_set',
    });

    expect(result).toEqual({ ok: true, removed: false });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('returns ok=false with error message when DB throws Error', async () => {
    const { db } = makeMockDb({ throwError: new Error('connection_lost') });

    const result = await unsetLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_A,
      tagName: 'tag_x',
    });

    expect(result).toEqual({ ok: false, error: 'connection_lost' });
  });

  it('returns ok=false with "unknown" when DB throws non-Error', async () => {
    const { db } = makeMockDb({ throwError: 'string_error' as unknown as Error });

    const result = await unsetLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_A,
      tagName: 'tag_y',
    });

    expect(result).toEqual({ ok: false, error: 'unknown' });
  });

  it('SQL contains workspace_id, lead_id, tag_name (BR-IDENTITY anchor)', async () => {
    // Verifica que o fragment SQL inclui as três colunas como filtro — defesa
    // contra cross-workspace leak (regra de ouro #14).
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    await unsetLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_A,
      tagName: 'wpp_joined',
    });

    const sqlArg = executeSpy.mock.calls[0]?.[0] as {
      queryChunks?: unknown[];
    };
    const flat = JSON.stringify(sqlArg.queryChunks ?? []);
    expect(flat).toContain('workspace_id');
    expect(flat).toContain('lead_id');
    expect(flat).toContain('tag_name');
    expect(flat).toContain('DELETE');
  });
});

// ---------------------------------------------------------------------------
// bulkApplyLeadTagsByIds
// ---------------------------------------------------------------------------

describe('bulkApplyLeadTagsByIds (T-TAGS-002, INV-LEAD-TAG-001)', () => {
  it('returns {applied:0, skipped:0} immediately when leadIds is empty (no DB call)', async () => {
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    const result = await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [],
      tagNames: ['tag_a'],
      setBy: 'user:abc',
    });

    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('returns {applied:0, skipped:0} immediately when tagNames is empty (no DB call)', async () => {
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    const result = await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: [],
      setBy: 'user:abc',
    });

    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('returns full applied count when cross-product 2x2 inserts 4 rows', async () => {
    // 2 leads × 2 tags = 4 expected; mock devolve 4 RETURNING rows.
    const { db, executeSpy } = makeMockDb({
      returningRows: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
    });

    const result = await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: ['tag_a', 'tag_b'],
      setBy: 'user:abc',
    });

    expect(result).toEqual({ applied: 4, skipped: 0 });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('idempotência (INV-LEAD-TAG-001): se 3 rows já existiam, ON CONFLICT pula → skipped=3', async () => {
    // 2x2=4 esperado; somente 1 row inserida → applied=1, skipped=3.
    const { db } = makeMockDb({ returningRows: [{ id: 'new-row' }] });

    const result = await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: ['tag_a', 'tag_b'],
      setBy: 'system',
    });

    expect(result).toEqual({ applied: 1, skipped: 3 });
  });

  it('idempotência total (mesma tag reaplicada): 0 inserts, skipped=expected', async () => {
    // INV-LEAD-TAG-001: re-aplicar mesma tag a mesmo lead vira no-op.
    // 1x1=1 esperado; nenhuma row inserida → applied=0, skipped=1.
    const { db } = makeMockDb({ returningRows: [] });

    const result = await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A],
      tagNames: ['already_set'],
      setBy: 'system',
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  it('on DB error returns neutral counters {applied:0, skipped:expected} and logs (não bubbla)', async () => {
    // Erro do DB não deve fazer throw — semântica "neutra" exposta no contrato.
    const { db } = makeMockDb({ throwError: new Error('hyperdrive_503') });

    const result = await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: ['tag_a', 'tag_b'],
      setBy: 'user:abc',
      requestId: 'req-123',
    });

    expect(result).toEqual({ applied: 0, skipped: 4 });
  });

  it('SQL fragment contains INSERT ... ON CONFLICT DO NOTHING and unnest cross-product', async () => {
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    await bulkApplyLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: ['tag_a'],
      setBy: 'user:abc',
    });

    const sqlArg = executeSpy.mock.calls[0]?.[0] as {
      queryChunks?: unknown[];
    };
    const flat = JSON.stringify(sqlArg.queryChunks ?? []);
    expect(flat).toContain('INSERT INTO lead_tags');
    expect(flat).toContain('ON CONFLICT');
    expect(flat).toContain('DO NOTHING');
    expect(flat).toContain('unnest');
    expect(flat).toContain('CROSS JOIN');
  });
});

// ---------------------------------------------------------------------------
// bulkUnsetLeadTagsByIds
// ---------------------------------------------------------------------------

describe('bulkUnsetLeadTagsByIds (T-TAGS-002, BR-IDENTITY)', () => {
  it('returns {removed:0} immediately when leadIds is empty', async () => {
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    const result = await bulkUnsetLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [],
      tagNames: ['tag_a'],
    });

    expect(result).toEqual({ removed: 0 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('returns {removed:0} immediately when tagNames is empty', async () => {
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    const result = await bulkUnsetLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A],
      tagNames: [],
    });

    expect(result).toEqual({ removed: 0 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('removes only the intersection: 2 leads × 2 tags but only 2 combinações existiam', async () => {
    // Cross-product = 4 candidates; só 2 realmente existiam → removed=2.
    const { db } = makeMockDb({
      returningRows: [{ id: 'row1' }, { id: 'row2' }],
    });

    const result = await bulkUnsetLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: ['tag_a', 'tag_b'],
    });

    expect(result).toEqual({ removed: 2 });
  });

  it('returns {removed:0} when DB throws (não bubbla, log via safeLog)', async () => {
    const { db } = makeMockDb({ throwError: new Error('pool_exhausted') });

    const result = await bulkUnsetLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A],
      tagNames: ['tag_a'],
    });

    expect(result).toEqual({ removed: 0 });
  });

  it('SQL fragment uses ANY(...) com workspace_id anchor (BR-IDENTITY)', async () => {
    const { db, executeSpy } = makeMockDb({ returningRows: [] });

    await bulkUnsetLeadTagsByIds({
      db,
      workspaceId: WORKSPACE_ID,
      leadIds: [LEAD_A, LEAD_B],
      tagNames: ['tag_a'],
    });

    const sqlArg = executeSpy.mock.calls[0]?.[0] as {
      queryChunks?: unknown[];
    };
    const flat = JSON.stringify(sqlArg.queryChunks ?? []);
    expect(flat).toContain('DELETE FROM lead_tags');
    expect(flat).toContain('workspace_id');
    expect(flat).toContain('ANY');
  });
});
