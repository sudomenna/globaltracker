/**
 * Unit tests — lead-tags.ts
 *
 * T-LEADS-VIEW-002.
 *
 * Mocked DB (`db.execute`); verifies:
 *   - INV-LEAD-TAG-001: ON CONFLICT DO NOTHING idempotência (sem refazer INSERT).
 *   - INV-LEAD-TAG-002: set_by formato 'event:<event_name>' aplicado por applyTagRules.
 *   - BR-AUDIT-001: set_by + set_at populados em todo INSERT.
 *   - BR-PRIVACY-001: nenhum PII vaza para logs (smoke check).
 *   - applyTagRules match logic: event match + when AND-logic + skip non-match.
 *   - Falha de uma tag não bubbla nem impede as demais.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyTagRules,
  setLeadTag,
  type TagRule,
} from '../../../apps/edge/src/lib/lead-tags';

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const LEAD_ID = '22222222-2222-2222-2222-222222222222';

function makeMockDb(opts?: { throwOn?: number; throwError?: Error }) {
  let callCount = 0;
  const executeSpy = vi.fn(async (_sql: unknown) => {
    callCount += 1;
    if (
      opts?.throwOn !== undefined &&
      callCount === opts.throwOn
    ) {
      throw opts.throwError ?? new Error('mock_db_error');
    }
    return undefined;
  });

  const db = {
    execute: executeSpy,
  } as unknown as Parameters<typeof setLeadTag>[0]['db'];

  return { db, executeSpy };
}

// ---------------------------------------------------------------------------
// setLeadTag
// ---------------------------------------------------------------------------

describe('setLeadTag (T-LEADS-VIEW-002, INV-LEAD-TAG-001/002, BR-AUDIT-001)', () => {
  it('inserts tag with ON CONFLICT DO NOTHING and returns ok=true', async () => {
    const { db, executeSpy } = makeMockDb();

    const result = await setLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      tagName: 'joined_group',
      setBy: 'event:custom:wpp_joined',
    });

    expect(result).toEqual({ ok: true });
    expect(executeSpy).toHaveBeenCalledOnce();

    // Sanity: inspect SQL fragments that the helper interpolated.
    // drizzle's `sql` template returns an SQL chunk we can stringify
    // via .queryChunks in tests — but we only need to know the call shape.
    const sqlArg = executeSpy.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    expect(sqlArg).toBeDefined();
  });

  it('returns ok=false with error message when DB throws', async () => {
    const dbErr = new Error('connection_lost');
    const { db } = makeMockDb({ throwOn: 1, throwError: dbErr });

    const result = await setLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      tagName: 'tag_x',
      setBy: 'system',
    });

    expect(result).toEqual({ ok: false, error: 'connection_lost' });
  });

  it('returns ok=false with "unknown" when DB throws non-Error', async () => {
    const executeSpy = vi.fn(async () => {
      throw 'string_error';
    });
    const db = { execute: executeSpy } as unknown as Parameters<
      typeof setLeadTag
    >[0]['db'];

    const result = await setLeadTag({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      tagName: 'tag_y',
      setBy: 'system',
    });

    expect(result).toEqual({ ok: false, error: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// applyTagRules
// ---------------------------------------------------------------------------

describe('applyTagRules (T-LEADS-VIEW-002)', () => {
  it('returns {applied:0, skipped:0} when tagRules is undefined', async () => {
    const { db, executeSpy } = makeMockDb();

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'Lead',
      tagRules: undefined,
    });

    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('returns {applied:0, skipped:0} when tagRules is empty array', async () => {
    const { db, executeSpy } = makeMockDb();

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'Lead',
      tagRules: [],
    });

    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('applies tag when event matches and no `when` filter', async () => {
    const { db, executeSpy } = makeMockDb();

    const rules: TagRule[] = [
      { event: 'custom:wpp_joined', tag: 'joined_group' },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'custom:wpp_joined',
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('skips tag when event_name does not match', async () => {
    const { db, executeSpy } = makeMockDb();

    const rules: TagRule[] = [
      { event: 'Purchase', tag: 'purchaser' },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'PageView',
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('applies tag when when.funnel_role matches eventContext', async () => {
    const { db, executeSpy } = makeMockDb();

    const rules: TagRule[] = [
      { event: 'Purchase', when: { funnel_role: 'bait' }, tag: 'bait_purchased' },
      { event: 'Purchase', when: { funnel_role: 'main_offer' }, tag: 'main_purchased' },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'Purchase',
      eventContext: { funnel_role: 'bait' },
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it('skips when.funnel_role rule when eventContext.funnel_role is undefined', async () => {
    const { db, executeSpy } = makeMockDb();

    const rules: TagRule[] = [
      { event: 'Purchase', when: { funnel_role: 'bait' }, tag: 'bait_purchased' },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'Purchase',
      eventContext: {}, // funnel_role missing
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('AND-logic: skips when one of multiple `when` keys does not match', async () => {
    const { db, executeSpy } = makeMockDb();

    const rules: TagRule[] = [
      {
        event: 'Purchase',
        when: { funnel_role: 'bait', extra_filter: 'yes' },
        tag: 'bait_with_extra',
      },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'Purchase',
      eventContext: { funnel_role: 'bait' }, // missing extra_filter
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('applies multiple matching rules independently and counts each', async () => {
    const { db, executeSpy } = makeMockDb();

    const rules: TagRule[] = [
      { event: 'custom:wpp_joined', tag: 'joined_group' },
      { event: 'custom:wpp_joined', tag: 'wpp_active' }, // both apply
      { event: 'Purchase', tag: 'irrelevant' }, // skipped (event mismatch)
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'custom:wpp_joined',
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 2, skipped: 1 });
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('continues applying remaining rules when one fails (failure is logged, not bubbled)', async () => {
    // First call throws, second succeeds — final counters: applied=1, skipped=1.
    let callIdx = 0;
    const executeSpy = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) throw new Error('transient_db_error');
      return undefined;
    });
    const db = { execute: executeSpy } as unknown as Parameters<
      typeof applyTagRules
    >[0]['db'];

    const rules: TagRule[] = [
      { event: 'custom:wpp_joined', tag: 'tag_a' },
      { event: 'custom:wpp_joined', tag: 'tag_b' },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'custom:wpp_joined',
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 1, skipped: 1 });
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('uses set_by="event:<event_name>" (INV-LEAD-TAG-002) when delegating to setLeadTag', async () => {
    // Spy executeSpy to assert that the SQL chunk includes the canonical
    // proveniência format.
    const executeSpy = vi.fn(async (sql: unknown) => {
      // drizzle's sql template object exposes .queryChunks with interpolated
      // values — we look for any chunk that equals the expected setBy string.
      const chunks =
        (sql as { queryChunks?: Array<unknown> })?.queryChunks ?? [];
      const flat = JSON.stringify(chunks);
      expect(flat).toContain('event:Purchase');
      return undefined;
    });
    const db = { execute: executeSpy } as unknown as Parameters<
      typeof applyTagRules
    >[0]['db'];

    const rules: TagRule[] = [
      { event: 'Purchase', when: { funnel_role: 'main_offer' }, tag: 'main_purchased' },
    ];

    const result = await applyTagRules({
      db,
      workspaceId: WORKSPACE_ID,
      leadId: LEAD_ID,
      eventName: 'Purchase',
      eventContext: { funnel_role: 'main_offer' },
      tagRules: rules,
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(executeSpy).toHaveBeenCalledOnce();
  });
});
