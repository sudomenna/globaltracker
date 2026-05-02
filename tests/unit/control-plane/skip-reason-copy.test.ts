/**
 * Unit tests — skip-reason-copy.ts
 *
 * BR-DISPATCH-004: skip_reason e error_code mapeados para copy PT-BR humanizado.
 * Each entry must have non-empty title and body.
 */

import { describe, expect, it } from 'vitest';
import {
  SKIP_REASON_COPY,
  getErrorCopy,
  getHttpErrorCopy,
  getSkipCopy,
} from '../../../apps/control-plane/src/lib/skip-reason-copy.js';

// ---------------------------------------------------------------------------
// SKIP_REASON_COPY catalog
// ---------------------------------------------------------------------------

describe('SKIP_REASON_COPY catalog', () => {
  it('BR-DISPATCH-004: has at least 5 entries', () => {
    expect(Object.keys(SKIP_REASON_COPY).length).toBeGreaterThanOrEqual(5);
  });

  it('BR-DISPATCH-004: every entry has non-empty title string', () => {
    for (const [key, entry] of Object.entries(SKIP_REASON_COPY)) {
      expect(
        typeof entry.title === 'string' && entry.title.length > 0,
        `entry "${key}" missing non-empty title`,
      ).toBe(true);
    }
  });

  it('BR-DISPATCH-004: every entry has non-empty body string', () => {
    for (const [key, entry] of Object.entries(SKIP_REASON_COPY)) {
      expect(
        typeof entry.body === 'string' && entry.body.length > 0,
        `entry "${key}" missing non-empty body`,
      ).toBe(true);
    }
  });

  it('contains entry for consent_denied:ad_user_data', () => {
    const entry = SKIP_REASON_COPY['consent_denied:ad_user_data'];
    expect(entry).toBeDefined();
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });

  it('contains entry for no_user_data', () => {
    const entry = SKIP_REASON_COPY.no_user_data;
    expect(entry).toBeDefined();
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });

  it('contains entry for integration_not_configured', () => {
    const entry = SKIP_REASON_COPY.integration_not_configured;
    expect(entry).toBeDefined();
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });

  it('contains entry for audience_not_eligible', () => {
    const entry = SKIP_REASON_COPY.audience_not_eligible;
    expect(entry).toBeDefined();
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });

  it('contains entry for archived_launch', () => {
    const entry = SKIP_REASON_COPY.archived_launch;
    expect(entry).toBeDefined();
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.body.length).toBeGreaterThan(0);
  });

  it('entries that have action have non-empty action.label and action.href', () => {
    for (const [key, entry] of Object.entries(SKIP_REASON_COPY)) {
      if (entry.action) {
        expect(
          entry.action.label.length > 0,
          `entry "${key}" action.label is empty`,
        ).toBe(true);
        expect(
          entry.action.href.length > 0,
          `entry "${key}" action.href is empty`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getSkipCopy
// ---------------------------------------------------------------------------

describe('getSkipCopy', () => {
  it('returns correct copy for known skip reason', () => {
    // BR-DISPATCH-004: known key returns its entry
    const copy = getSkipCopy('no_user_data');
    expect(copy.title).toBe(SKIP_REASON_COPY.no_user_data?.title);
    expect(copy.body).toBe(SKIP_REASON_COPY.no_user_data?.body);
  });

  it('returns fallback copy for unknown skip reason', () => {
    const copy = getSkipCopy('totally_unknown_reason_xyz');
    expect(typeof copy.title).toBe('string');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(typeof copy.body).toBe('string');
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('returns fallback copy for empty string reason', () => {
    const copy = getSkipCopy('');
    expect(typeof copy.title).toBe('string');
    expect(copy.title.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getErrorCopy
// ---------------------------------------------------------------------------

describe('getErrorCopy', () => {
  it('returns meta invalid_pixel_id copy for meta destination', () => {
    const copy = getErrorCopy('meta', 'invalid_pixel_id');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('returns ga4 invalid_measurement_id copy for ga4 destination', () => {
    const copy = getErrorCopy('ga4', 'invalid_measurement_id');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('returns google_ads invalid_conversion_action copy for google_ads destination', () => {
    const copy = getErrorCopy('google_ads', 'invalid_conversion_action');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('returns fallback for unknown destination', () => {
    const copy = getErrorCopy('unknown_provider', 'some_error');
    expect(typeof copy.title).toBe('string');
    expect(copy.title.length).toBeGreaterThan(0);
  });

  it('returns fallback for known destination but unknown error code', () => {
    const copy = getErrorCopy('meta', 'totally_unknown_error');
    expect(typeof copy.title).toBe('string');
    expect(copy.title.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getHttpErrorCopy
// ---------------------------------------------------------------------------

describe('getHttpErrorCopy', () => {
  it('returns copy for validation_error code', () => {
    const copy = getHttpErrorCopy(400, 'validation_error');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('returns copy for bot_detected code', () => {
    const copy = getHttpErrorCopy(400, 'bot_detected');
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it('returns fallback for unknown http error code', () => {
    const copy = getHttpErrorCopy(500, 'non_existent_code');
    expect(typeof copy.title).toBe('string');
    expect(copy.title.length).toBeGreaterThan(0);
  });
});
