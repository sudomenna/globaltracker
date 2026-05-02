/**
 * Unit tests — skip_reason required when creating skipped dispatch jobs
 *
 * INV-DISPATCH-004: job with status='skipped' MUST have non-empty skip_reason.
 * BR-DISPATCH-004: skip_reason is required; canonical values include
 *   'consent_denied:<finality>', 'no_user_data', 'integration_not_configured', etc.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type DispatchJobInput,
  createSkippedJob,
} from '../../../apps/edge/src/lib/dispatch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT: DispatchJobInput = {
  workspace_id: 'ws-00000000-0000-0000-0000-000000000001',
  event_id: 'evt-00000000-0000-0000-0000-000000000002',
  destination: 'meta_capi',
  destination_account_id: 'biz-123',
  destination_resource_id: 'pixel-456',
  destination_subresource: null,
};

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function makeDb(opts: { insertReturns?: object | null } = {}) {
  const { insertReturns = { id: 'job-uuid-001', status: 'skipped' } } = opts;

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue(insertReturns ? [insertReturns] : []),
        }),
      }),
    }),
  } as unknown as Parameters<typeof createSkippedJob>[2];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSkippedJob', () => {
  it('INV-DISPATCH-004: empty skip_reason returns empty_skip_reason error', async () => {
    const db = makeDb();
    const result = await createSkippedJob(BASE_INPUT, '', db);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('empty_skip_reason');
    }
    // DB must not be called when skip_reason is invalid
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('INV-DISPATCH-004: whitespace-only skip_reason returns empty_skip_reason error', async () => {
    const db = makeDb();
    const result = await createSkippedJob(BASE_INPUT, '   ', db);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('empty_skip_reason');
    }
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('BR-DISPATCH-004: valid skip_reason creates job successfully', async () => {
    const db = makeDb({
      insertReturns: {
        id: 'job-001',
        status: 'skipped',
        skipReason: 'no_user_data',
      },
    });

    const result = await createSkippedJob(BASE_INPUT, 'no_user_data', db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('skipped');
    }
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it('BR-DISPATCH-004: consent_denied skip_reason is accepted', async () => {
    const db = makeDb({
      insertReturns: {
        id: 'job-002',
        status: 'skipped',
        skipReason: 'consent_denied:analytics',
      },
    });

    const result = await createSkippedJob(
      BASE_INPUT,
      'consent_denied:analytics',
      db,
    );

    expect(result.ok).toBe(true);
  });

  it('BR-DISPATCH-004: integration_not_configured skip_reason is accepted', async () => {
    const db = makeDb({
      insertReturns: {
        id: 'job-003',
        status: 'skipped',
        skipReason: 'integration_not_configured',
      },
    });

    const result = await createSkippedJob(
      BASE_INPUT,
      'integration_not_configured',
      db,
    );

    expect(result.ok).toBe(true);
  });

  it('BR-DISPATCH-004: conflict (idempotency_key already exists) returns conflict_existing', async () => {
    // ON CONFLICT DO NOTHING returns empty array — existing job, skipped insert
    const db = makeDb({ insertReturns: null });

    const result = await createSkippedJob(BASE_INPUT, 'no_user_data', db);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict_existing');
    }
  });

  it('INV-DISPATCH-004: skip_reason is trimmed before storage', async () => {
    let capturedValues: Record<string, unknown> | null = null;

    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals;
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: 'job-004',
                  status: 'skipped',
                  skipReason: vals.skipReason,
                },
              ]),
            }),
          };
        }),
      }),
    } as unknown as Parameters<typeof createSkippedJob>[2];

    await createSkippedJob(BASE_INPUT, '  no_user_data  ', db);

    // BR-DISPATCH-004: trimmed value stored
    expect(capturedValues).not.toBeNull();
    expect(capturedValues?.skipReason).toBe('no_user_data');
  });
});
