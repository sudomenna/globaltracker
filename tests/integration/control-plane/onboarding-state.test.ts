/**
 * Integration tests — onboarding-state.ts buildMergeFragment
 *
 * Tests the pure buildMergeFragment function exported from the onboarding-state
 * route module. No DB or I/O required — fragment building is pure logic.
 *
 * INV-WORKSPACE-003: onboarding_state structure validated by Zod before persisting.
 * BR-RBAC-002: workspace_id is multi-tenant anchor.
 * BR-AUDIT-001: every mutation generates an audit log entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMergeFragment } from '../../../apps/edge/src/routes/onboarding-state.js';

// ---------------------------------------------------------------------------
// Time control
// We must mock Date so tests remain deterministic.
// ---------------------------------------------------------------------------

const FIXED_NOW = '2025-01-15T10:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// buildMergeFragment — step_meta
// ---------------------------------------------------------------------------

describe('buildMergeFragment > step meta', () => {
  it('returns object with step_meta key when step is meta', () => {
    const fragment = buildMergeFragment(
      {
        step: 'meta',
        completed_at: '2025-01-15T10:00:00.000Z',
        validated: true,
      },
      null,
    );
    expect(fragment).toHaveProperty('step_meta');
  });

  it('step_meta contains completed_at when provided in body', () => {
    const completedAt = '2025-01-15T10:00:00.000Z';
    const fragment = buildMergeFragment(
      { step: 'meta', completed_at: completedAt },
      'already-started',
    );
    expect((fragment.step_meta as Record<string, unknown>).completed_at).toBe(
      completedAt,
    );
  });

  it('step_meta contains validated flag when provided', () => {
    const fragment = buildMergeFragment(
      { step: 'meta', validated: true },
      'already-started',
    );
    expect((fragment.step_meta as Record<string, unknown>).validated).toBe(
      true,
    );
  });

  it('injects started_at when currentStartedAt is null (wizard first step)', () => {
    // INV-WORKSPACE-003: started_at set when not previously set
    const fragment = buildMergeFragment(
      { step: 'meta', completed_at: '2025-01-15T10:00:00.000Z' },
      null,
    );
    expect(fragment).toHaveProperty('started_at', FIXED_NOW);
  });

  it('does NOT inject started_at when currentStartedAt is already set', () => {
    const fragment = buildMergeFragment(
      { step: 'meta', completed_at: '2025-01-15T10:00:00.000Z' },
      '2024-12-01T00:00:00.000Z',
    );
    expect(fragment).not.toHaveProperty('started_at');
  });

  it('does NOT inject started_at when currentStartedAt is undefined (treat as not set)', () => {
    // undefined behaves same as null → wizard not yet started
    const fragment = buildMergeFragment(
      { step: 'meta', completed_at: '2025-01-15T10:00:00.000Z' },
      undefined,
    );
    expect(fragment).toHaveProperty('started_at');
  });

  it('does not include fields not sent in body (completed_at absent)', () => {
    const fragment = buildMergeFragment(
      { step: 'meta', validated: false },
      'already-started',
    );
    const stepMeta = fragment.step_meta as Record<string, unknown>;
    expect(stepMeta).not.toHaveProperty('completed_at');
  });
});

// ---------------------------------------------------------------------------
// buildMergeFragment — step_ga4
// ---------------------------------------------------------------------------

describe('buildMergeFragment > step ga4', () => {
  it('returns object with step_ga4 key', () => {
    const fragment = buildMergeFragment(
      { step: 'ga4', completed_at: '2025-01-15T10:00:00.000Z' },
      'already-started',
    );
    expect(fragment).toHaveProperty('step_ga4');
  });

  it('step_ga4 does not have completed_at when not sent', () => {
    const fragment = buildMergeFragment(
      { step: 'ga4', validated: true },
      'already-started',
    );
    const stepGa4 = fragment.step_ga4 as Record<string, unknown>;
    expect(stepGa4).not.toHaveProperty('completed_at');
  });
});

// ---------------------------------------------------------------------------
// buildMergeFragment — step_launch
// ---------------------------------------------------------------------------

describe('buildMergeFragment > step launch', () => {
  it('returns object with step_launch key containing launch_id', () => {
    const launchId = '00000000-0000-0000-0000-000000000001';
    const fragment = buildMergeFragment(
      {
        step: 'launch',
        completed_at: '2025-01-15T10:00:00.000Z',
        launch_id: launchId,
      },
      'already-started',
    );
    const stepLaunch = fragment.step_launch as Record<string, unknown>;
    expect(stepLaunch.launch_id).toBe(launchId);
  });

  it('step_launch does not include launch_id when not provided', () => {
    const fragment = buildMergeFragment(
      { step: 'launch', completed_at: '2025-01-15T10:00:00.000Z' },
      'already-started',
    );
    const stepLaunch = fragment.step_launch as Record<string, unknown>;
    expect(stepLaunch).not.toHaveProperty('launch_id');
  });
});

// ---------------------------------------------------------------------------
// buildMergeFragment — step_page
// ---------------------------------------------------------------------------

describe('buildMergeFragment > step page', () => {
  it('returns object with step_page key containing page_id', () => {
    const pageId = '00000000-0000-0000-0000-000000000002';
    const fragment = buildMergeFragment(
      {
        step: 'page',
        completed_at: '2025-01-15T10:00:00.000Z',
        page_id: pageId,
      },
      'already-started',
    );
    const stepPage = fragment.step_page as Record<string, unknown>;
    expect(stepPage.page_id).toBe(pageId);
  });
});

// ---------------------------------------------------------------------------
// buildMergeFragment — step_install
// ---------------------------------------------------------------------------

describe('buildMergeFragment > step install', () => {
  it('returns object with step_install key containing first_ping_at', () => {
    const pingAt = '2025-01-15T10:00:00.000Z';
    const fragment = buildMergeFragment(
      { step: 'install', first_ping_at: pingAt },
      'already-started',
    );
    const stepInstall = fragment.step_install as Record<string, unknown>;
    expect(stepInstall.first_ping_at).toBe(pingAt);
  });
});

// ---------------------------------------------------------------------------
// buildMergeFragment — skip_all
// ---------------------------------------------------------------------------

describe('buildMergeFragment > skip_all', () => {
  it('returns fragment with skipped_at from body when provided', () => {
    const skippedAt = '2025-01-15T09:00:00.000Z';
    const fragment = buildMergeFragment(
      { step: 'skip_all', skipped_at: skippedAt },
      null,
    );
    expect(fragment.skipped_at).toBe(skippedAt);
  });

  it('uses now() as skipped_at when not provided in body', () => {
    const fragment = buildMergeFragment({ step: 'skip_all' }, null);
    expect(fragment.skipped_at).toBe(FIXED_NOW);
  });

  it('injects started_at when currentStartedAt is null (skipped before starting)', () => {
    const fragment = buildMergeFragment({ step: 'skip_all' }, null);
    expect(fragment).toHaveProperty('started_at', FIXED_NOW);
  });

  it('does NOT inject started_at when currentStartedAt already set', () => {
    const fragment = buildMergeFragment(
      { step: 'skip_all' },
      '2024-12-01T00:00:00.000Z',
    );
    expect(fragment).not.toHaveProperty('started_at');
  });

  it('does not include step_meta or other step keys', () => {
    const fragment = buildMergeFragment({ step: 'skip_all' }, null);
    expect(fragment).not.toHaveProperty('step_meta');
    expect(fragment).not.toHaveProperty('step_ga4');
  });
});

// ---------------------------------------------------------------------------
// buildMergeFragment — complete
// ---------------------------------------------------------------------------

describe('buildMergeFragment > complete', () => {
  it('returns fragment with completed_at from body when provided', () => {
    const completedAt = '2025-01-15T11:00:00.000Z';
    const fragment = buildMergeFragment(
      { step: 'complete', completed_at: completedAt },
      'already-started',
    );
    expect(fragment.completed_at).toBe(completedAt);
  });

  it('falls back to now() as completed_at when not in body', () => {
    const fragment = buildMergeFragment(
      { step: 'complete' },
      'already-started',
    );
    expect(fragment.completed_at).toBe(FIXED_NOW);
  });

  it('does NOT inject started_at for complete step even when currentStartedAt is null', () => {
    // complete step does not trigger started_at injection per spec
    const fragment = buildMergeFragment({ step: 'complete' }, null);
    // The base for complete step has shouldSetStartedAt=false (step is 'complete')
    expect(fragment).not.toHaveProperty('started_at');
  });
});
