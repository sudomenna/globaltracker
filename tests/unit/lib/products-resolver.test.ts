/**
 * Unit tests — products-resolver.ts
 *
 * Mocked DB; verifies BR-PRODUCT-002 (auto-creation with category=NULL,
 * preserving existing rows on idempotent calls).
 *
 * T-PRODUCTS-003.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type UpsertProductResult,
  upsertProduct,
} from '../../../apps/edge/src/lib/products-resolver';

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const PRODUCT_ID = 'prod-00000000-0000-0000-0000-000000000001';

interface SelectRow {
  id: string;
  category: string | null;
  name: string;
}

interface MockDbOptions {
  /** Rows returned by the first SELECT (fast-path). */
  firstSelectRows: SelectRow[];
  /** Rows returned by INSERT … RETURNING (empty = ON CONFLICT DO NOTHING fired). */
  insertRows: SelectRow[];
  /** Rows returned by the post-conflict re-SELECT. Only consulted if INSERT returns 0 rows. */
  rereadRows?: SelectRow[];
}

function makeMockDb(opts: MockDbOptions) {
  // SELECT chain: db.select().from().where().limit() → Promise<rows>
  // Drizzle calls .limit() last, which awaits to rows. We need TWO sequential
  // SELECT chains (initial fast-path + post-conflict re-read), each with its
  // own .limit() resolution.
  const limitMock = vi
    .fn()
    .mockResolvedValueOnce(opts.firstSelectRows)
    .mockResolvedValueOnce(opts.rereadRows ?? []);
  const whereSelectMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereSelectMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  // INSERT chain: db.insert().values().onConflictDoNothing().returning()
  const returningMock = vi.fn().mockResolvedValue(opts.insertRows);
  const onConflictMock = vi
    .fn()
    .mockReturnValue({ returning: returningMock });
  const valuesMock = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing: onConflictMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  const db = {
    select: selectMock,
    insert: insertMock,
  } as unknown as Parameters<typeof upsertProduct>[0];

  return {
    db,
    selectMock,
    insertMock,
    valuesMock,
    onConflictMock,
    returningMock,
    limitMock,
  };
}

const baseInput = {
  workspaceId: WORKSPACE_ID,
  externalProvider: 'guru' as const,
  externalProductId: 'guru-prod-abc',
  name: 'Workshop Comprador',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upsertProduct (T-PRODUCTS-003, BR-PRODUCT-002)', () => {
  it('creates product when not present — INSERT path returns isNew=true, category=null', async () => {
    const mock = makeMockDb({
      firstSelectRows: [],
      insertRows: [{ id: PRODUCT_ID, category: null, name: baseInput.name }],
    });

    const result = await upsertProduct(mock.db, baseInput);

    expect(result).toEqual<UpsertProductResult>({
      id: PRODUCT_ID,
      category: null,
      name: baseInput.name,
      isNew: true,
    });

    // Insert was actually called.
    expect(mock.insertMock).toHaveBeenCalledOnce();
    expect(mock.valuesMock).toHaveBeenCalledOnce();

    // BR-PRODUCT-002: insert payload has category=NULL.
    const valuesArg = mock.valuesMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(valuesArg).toMatchObject({
      workspaceId: WORKSPACE_ID,
      externalProvider: 'guru',
      externalProductId: 'guru-prod-abc',
      name: baseInput.name,
      category: null,
      status: 'active',
    });
  });

  it('returns existing product without INSERT when row already exists (category=null)', async () => {
    const mock = makeMockDb({
      firstSelectRows: [{ id: PRODUCT_ID, category: null, name: 'Old Name' }],
      insertRows: [], // never reached
    });

    const result = await upsertProduct(mock.db, baseInput);

    expect(result).toEqual<UpsertProductResult>({
      id: PRODUCT_ID,
      category: null,
      name: 'Old Name',
      isNew: false,
    });

    // Critical: NO insert when row already exists — preserves operator state.
    expect(mock.insertMock).not.toHaveBeenCalled();
  });

  it('preserves operator-assigned category when product already exists (curso_online)', async () => {
    const mock = makeMockDb({
      firstSelectRows: [
        { id: PRODUCT_ID, category: 'curso_online', name: 'Curso X' },
      ],
      insertRows: [],
    });

    const result = await upsertProduct(mock.db, {
      ...baseInput,
      name: 'NEW NAME from webhook (must not overwrite)',
    });

    expect(result).toEqual<UpsertProductResult>({
      id: PRODUCT_ID,
      category: 'curso_online',
      name: 'Curso X',
      isNew: false,
    });
    expect(mock.insertMock).not.toHaveBeenCalled();
  });

  it('handles race: SELECT empty → INSERT ON CONFLICT DO NOTHING → re-SELECT recovers row', async () => {
    const mock = makeMockDb({
      firstSelectRows: [],
      insertRows: [], // conflict fired, returning yields 0 rows
      rereadRows: [
        { id: PRODUCT_ID, category: 'webinar', name: 'Race-winning row' },
      ],
    });

    const result = await upsertProduct(mock.db, baseInput);

    expect(result).toEqual<UpsertProductResult>({
      id: PRODUCT_ID,
      category: 'webinar',
      name: 'Race-winning row',
      isNew: false,
    });

    // Two SELECTs (initial + re-read) and one INSERT attempt.
    expect(mock.selectMock).toHaveBeenCalledTimes(2);
    expect(mock.insertMock).toHaveBeenCalledOnce();
  });

  it('throws when INSERT yields 0 rows AND re-SELECT also empty (catastrophic)', async () => {
    const mock = makeMockDb({
      firstSelectRows: [],
      insertRows: [],
      rereadRows: [],
    });

    await expect(upsertProduct(mock.db, baseInput)).rejects.toThrow(
      /failed to insert and re-read product/,
    );
  });

  it('passes correct conflict target to onConflictDoNothing (workspace + provider + external_id)', async () => {
    const mock = makeMockDb({
      firstSelectRows: [],
      insertRows: [{ id: PRODUCT_ID, category: null, name: baseInput.name }],
    });

    await upsertProduct(mock.db, baseInput);

    expect(mock.onConflictMock).toHaveBeenCalledOnce();
    const arg = mock.onConflictMock.mock.calls[0]?.[0] as
      | { target?: unknown[] }
      | undefined;
    expect(arg).toBeDefined();
    expect(Array.isArray(arg?.target)).toBe(true);
    expect(arg?.target).toHaveLength(3);
  });

  it('does not call INSERT at all on the fast path', async () => {
    const mock = makeMockDb({
      firstSelectRows: [{ id: PRODUCT_ID, category: 'ebook', name: 'E-book' }],
      insertRows: [],
    });

    await upsertProduct(mock.db, baseInput);

    expect(mock.selectMock).toHaveBeenCalledOnce();
    expect(mock.insertMock).not.toHaveBeenCalled();
    expect(mock.valuesMock).not.toHaveBeenCalled();
    expect(mock.onConflictMock).not.toHaveBeenCalled();
    expect(mock.returningMock).not.toHaveBeenCalled();
  });

  it('issues exactly one SELECT and one INSERT when product is new (no race)', async () => {
    const mock = makeMockDb({
      firstSelectRows: [],
      insertRows: [{ id: PRODUCT_ID, category: null, name: baseInput.name }],
    });

    await upsertProduct(mock.db, baseInput);

    // Initial SELECT only — re-SELECT is skipped because INSERT returned a row.
    expect(mock.selectMock).toHaveBeenCalledOnce();
    expect(mock.insertMock).toHaveBeenCalledOnce();
    expect(mock.returningMock).toHaveBeenCalledOnce();
  });
});
