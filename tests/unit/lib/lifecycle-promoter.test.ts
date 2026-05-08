/**
 * Unit tests — lifecycle-promoter.ts
 *
 * Mocked DB; verifies BR-PRODUCT-001 (no regression) plus idempotency
 * and skip-UPDATE-on-no-change behavior.
 *
 * BR-PRODUCT-001: hierarquia monotônica — promoteLeadLifecycle só faz UPDATE
 *                 se candidate tem rank estritamente maior que current.
 *
 * T-PRODUCTS-002.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type PromoteResult,
  promoteLeadLifecycle,
} from '../../../apps/edge/src/lib/lifecycle-promoter';
import type { LifecycleStatus } from '../../../apps/edge/src/lib/lifecycle-rules';

// ---------------------------------------------------------------------------
// Mock DB builders — same pattern as tests/unit/identity/lead-resolver-*
// ---------------------------------------------------------------------------

const LEAD_ID = 'lead-00000000-0000-0000-0000-000000000001';

/**
 * Build a mock Db whose initial SELECT returns a single row with the given
 * lifecycle_status, and whose UPDATE chain is fully recordable for assertions.
 *
 * Pass `selectRows: []` to simulate "lead not found".
 */
function makeMockDb(selectRows: Array<{ lifecycleStatus: string }>): {
  db: Parameters<typeof promoteLeadLifecycle>[0];
  updateSpy: ReturnType<typeof vi.fn>;
  setSpy: ReturnType<typeof vi.fn>;
  whereSpy: ReturnType<typeof vi.fn>;
} {
  const limitSpy = vi.fn().mockResolvedValue(selectRows);
  const selectWhereSpy = vi.fn().mockReturnValue({ limit: limitSpy });
  const fromSpy = vi.fn().mockReturnValue({ where: selectWhereSpy });
  const selectSpy = vi.fn().mockReturnValue({ from: fromSpy });

  const whereSpy = vi.fn().mockResolvedValue([]);
  const setSpy = vi.fn().mockReturnValue({ where: whereSpy });
  const updateSpy = vi.fn().mockReturnValue({ set: setSpy });

  const db = {
    select: selectSpy,
    update: updateSpy,
  } as unknown as Parameters<typeof promoteLeadLifecycle>[0];

  return { db, updateSpy, setSpy, whereSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promoteLeadLifecycle (T-PRODUCTS-002, BR-PRODUCT-001)', () => {
  // ---- promotion paths (rank up) ----

  it('promotes contato → lead, returns updated=true with new current', async () => {
    const { db, updateSpy, setSpy } = makeMockDb([
      { lifecycleStatus: 'contato' },
    ]);

    const result = await promoteLeadLifecycle(db, LEAD_ID, 'lead');

    const expected: PromoteResult = {
      updated: true,
      previous: 'contato',
      current: 'lead',
    };
    expect(result).toEqual(expected);

    // UPDATE chain was invoked exactly once with lifecycleStatus='lead'
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(setSpy).toHaveBeenCalledOnce();
    const setArg = setSpy.mock.calls[0]?.[0];
    expect(setArg).toMatchObject({ lifecycleStatus: 'lead' });
    expect(setArg).toHaveProperty('updatedAt');
  });

  it('promotes lead → mentorado (multi-step jump), updated=true', async () => {
    const { db, updateSpy, setSpy } = makeMockDb([{ lifecycleStatus: 'lead' }]);

    const result = await promoteLeadLifecycle(db, LEAD_ID, 'mentorado');

    expect(result).toEqual<PromoteResult>({
      updated: true,
      previous: 'lead',
      current: 'mentorado',
    });
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(setSpy.mock.calls[0]?.[0]).toMatchObject({
      lifecycleStatus: 'mentorado',
    });
  });

  it('promotes cliente → aluno, updated=true', async () => {
    const { db, updateSpy } = makeMockDb([{ lifecycleStatus: 'cliente' }]);
    const result = await promoteLeadLifecycle(db, LEAD_ID, 'aluno');
    expect(result).toEqual<PromoteResult>({
      updated: true,
      previous: 'cliente',
      current: 'aluno',
    });
    expect(updateSpy).toHaveBeenCalledOnce();
  });

  // ---- non-regression paths (BR-PRODUCT-001) ----

  it('BR-PRODUCT-001: cliente + candidate=lead → updated=false (no regression, no UPDATE)', async () => {
    const { db, updateSpy } = makeMockDb([{ lifecycleStatus: 'cliente' }]);

    const result = await promoteLeadLifecycle(db, LEAD_ID, 'lead');

    expect(result).toEqual<PromoteResult>({
      updated: false,
      previous: 'cliente',
      current: 'cliente',
    });
    // Critical: NO UPDATE issued when promotion is blocked.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('BR-PRODUCT-001: aluno + candidate=cliente → updated=false', async () => {
    const { db, updateSpy } = makeMockDb([{ lifecycleStatus: 'aluno' }]);
    const result = await promoteLeadLifecycle(db, LEAD_ID, 'cliente');
    expect(result).toEqual<PromoteResult>({
      updated: false,
      previous: 'aluno',
      current: 'aluno',
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('BR-PRODUCT-001: mentorado + candidate=aluno → updated=false', async () => {
    const { db, updateSpy } = makeMockDb([{ lifecycleStatus: 'mentorado' }]);
    const result = await promoteLeadLifecycle(db, LEAD_ID, 'aluno');
    expect(result).toEqual<PromoteResult>({
      updated: false,
      previous: 'mentorado',
      current: 'mentorado',
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('BR-PRODUCT-001: mentorado + candidate=contato → updated=false (max → min blocked)', async () => {
    const { db, updateSpy } = makeMockDb([{ lifecycleStatus: 'mentorado' }]);
    const result = await promoteLeadLifecycle(db, LEAD_ID, 'contato');
    expect(result).toEqual<PromoteResult>({
      updated: false,
      previous: 'mentorado',
      current: 'mentorado',
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // ---- idempotent path (same value) ----

  it('idempotent: aluno + candidate=aluno → updated=false (no UPDATE issued)', async () => {
    const { db, updateSpy } = makeMockDb([{ lifecycleStatus: 'aluno' }]);

    const result = await promoteLeadLifecycle(db, LEAD_ID, 'aluno');

    expect(result).toEqual<PromoteResult>({
      updated: false,
      previous: 'aluno',
      current: 'aluno',
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('idempotent for every status: x → x is no-op', async () => {
    const all: LifecycleStatus[] = [
      'contato',
      'lead',
      'cliente',
      'aluno',
      'mentorado',
    ];
    for (const s of all) {
      const { db, updateSpy } = makeMockDb([{ lifecycleStatus: s }]);
      const r = await promoteLeadLifecycle(db, LEAD_ID, s);
      expect(r).toEqual<PromoteResult>({
        updated: false,
        previous: s,
        current: s,
      });
      expect(updateSpy).not.toHaveBeenCalled();
    }
  });

  // ---- error paths ----

  it('throws when lead not found', async () => {
    const { db } = makeMockDb([]); // empty result set

    await expect(promoteLeadLifecycle(db, LEAD_ID, 'lead')).rejects.toThrow(
      /lead not found/,
    );
  });

  it('throws when DB row has non-canonical lifecycle_status (defensive boundary check)', async () => {
    const { db } = makeMockDb([
      { lifecycleStatus: 'customer' /* english, invalid */ },
    ]);

    await expect(promoteLeadLifecycle(db, LEAD_ID, 'aluno')).rejects.toThrow(
      /non-canonical lifecycle_status/,
    );
  });

  // ---- behavior detail: SELECT happens once, UPDATE skipped on no-op ----

  it('issues exactly one SELECT and zero UPDATEs on no-op call', async () => {
    const mock = makeMockDb([{ lifecycleStatus: 'cliente' }]);
    const selectSpy = (
      mock.db as unknown as { select: ReturnType<typeof vi.fn> }
    ).select;

    await promoteLeadLifecycle(mock.db, LEAD_ID, 'lead'); // blocked by BR-PRODUCT-001

    expect(selectSpy).toHaveBeenCalledOnce();
    expect(mock.updateSpy).not.toHaveBeenCalled();
  });

  it('issues exactly one SELECT and one UPDATE on real promotion', async () => {
    const mock = makeMockDb([{ lifecycleStatus: 'contato' }]);
    const selectSpy = (
      mock.db as unknown as { select: ReturnType<typeof vi.fn> }
    ).select;

    await promoteLeadLifecycle(mock.db, LEAD_ID, 'mentorado');

    expect(selectSpy).toHaveBeenCalledOnce();
    expect(mock.updateSpy).toHaveBeenCalledOnce();
  });
});
