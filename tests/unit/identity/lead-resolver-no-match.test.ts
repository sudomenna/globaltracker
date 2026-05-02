/**
 * Unit tests — lead-resolver: Case A (0 matches → create new lead)
 *
 * Uses a mock DB (no real database connection).
 *
 * BR-IDENTITY-001: aliases ativos únicos por (workspace_id, identifier_type, identifier_hash)
 * BR-IDENTITY-002: normalize before hash
 * INV-IDENTITY-007: normalização canônica antes do hash
 */

import { describe, expect, it, vi } from 'vitest';
import {
  normalizeEmail,
  normalizePhone,
  resolveLeadByAliases,
} from '../../../apps/edge/src/lib/lead-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';
const NEW_LEAD_ID = 'lead-00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Mock DB factory for "no existing aliases"
// A thenable where() that also has a limit() method lets the resolver work
// whether it does .where() or .where().limit().
// ---------------------------------------------------------------------------

function makeThenableWhere(resolvedValue: unknown) {
  const obj = {
    // biome-ignore lint/suspicious/noThenProperty: mock needs to be both awaitable and chainable
    then: (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolvedValue).then(onfulfilled),
    limit: vi.fn().mockResolvedValue(resolvedValue),
    orderBy: vi
      .fn()
      .mockReturnValue({ limit: vi.fn().mockResolvedValue(resolvedValue) }),
  };
  return obj;
}

function makeEmptyDb() {
  const returningMock = vi.fn().mockResolvedValue([{ id: NEW_LEAD_ID }]);
  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  // select().from().where() → thenable resolving to [] (no aliases found)
  const whereMock = vi.fn().mockReturnValue(makeThenableWhere([]));
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return { insert: insertMock, select: selectMock } as unknown as Parameters<
    typeof resolveLeadByAliases
  >[2];
}

// ---------------------------------------------------------------------------
// normalizeEmail
// INV-IDENTITY-007
// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  it('converts to lowercase', () => {
    // BR-IDENTITY-002: email lowercase + trim
    expect(normalizeEmail('Foo@Bar.COM')).toBe('foo@bar.com');
  });

  it('trims whitespace', () => {
    // INV-IDENTITY-007: canonical normalization before hash
    expect(normalizeEmail('  foo@bar.com  ')).toBe('foo@bar.com');
  });

  it('handles already-normalized email', () => {
    expect(normalizeEmail('foo@bar.com')).toBe('foo@bar.com');
  });
});

// ---------------------------------------------------------------------------
// normalizePhone
// INV-IDENTITY-007
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
  it('preserves E.164 format with + prefix', () => {
    // BR-IDENTITY-002: phone E.164
    expect(normalizePhone('+5511999990000')).toBe('+5511999990000');
  });

  it('infers +55 country code for 11-digit BR number', () => {
    // INV-IDENTITY-007: BR phone inference
    expect(normalizePhone('11999990000')).toBe('+5511999990000');
  });

  it('strips parentheses, hyphens, spaces and adds +55 for BR numbers', () => {
    // (11) 99999-0000 → digits: 11999990000 (11 digits) → +5511999990000
    expect(normalizePhone('(11) 99999-0000')).toBe('+5511999990000');
  });

  it('returns null for ambiguous short number without country code', () => {
    // BR-IDENTITY-002: phone without country code → error
    expect(normalizePhone('9999-9999')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('strips non-digit chars from E.164 input', () => {
    // +55 (11) 9-9999-0000 → hasPlus=true, digits: 55119999 0000 = 5511999990000 → +5511999990000
    expect(normalizePhone('+55 (11) 9-9999-0000')).toBe('+5511999990000');
  });
});

// ---------------------------------------------------------------------------
// resolveLeadByAliases — Case A: 0 matches → create new lead
// ---------------------------------------------------------------------------

describe('resolveLeadByAliases — 0 matches', () => {
  it('returns invalid_input when no identifiers provided', async () => {
    const db = makeEmptyDb();
    const result = await resolveLeadByAliases({}, WORKSPACE_ID, db);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
  });

  it('creates a new lead when email matches nothing', async () => {
    // Case A: 0 alias matches → was_created=true, merge_executed=false
    const aliasInsertValues = vi.fn().mockResolvedValue([]);
    const leadInsertReturning = vi
      .fn()
      .mockResolvedValue([{ id: NEW_LEAD_ID }]);
    const leadInsertValues = vi
      .fn()
      .mockReturnValue({ returning: leadInsertReturning });

    let insertCallCount = 0;
    const insertMock = vi.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        // First insert = lead row
        return { values: leadInsertValues };
      }
      // Subsequent inserts = alias rows (no returning needed)
      return { values: aliasInsertValues };
    });

    // select → no matching aliases
    const whereMock = vi.fn().mockReturnValue(makeThenableWhere([]));
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = {
      insert: insertMock,
      select: selectMock,
    } as unknown as Parameters<typeof resolveLeadByAliases>[2];

    const result = await resolveLeadByAliases(
      { email: 'new@example.com' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lead_id).toBe(NEW_LEAD_ID);
      expect(result.value.was_created).toBe(true);
      expect(result.value.merge_executed).toBe(false);
      expect(result.value.merged_lead_ids).toHaveLength(0);
    }
  });

  it('returns invalid_input when phone cannot be normalized', async () => {
    // BR-IDENTITY-002: phone normalization failure → error
    const db = makeEmptyDb();
    const result = await resolveLeadByAliases(
      { phone: '9999' },
      WORKSPACE_ID,
      db,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain('phone_normalization_failed');
    }
  });
});
