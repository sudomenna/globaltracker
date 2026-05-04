/**
 * Unit tests — apps/control-plane/src/lib/page-role-defaults.ts
 *
 * T-ID: T-FUNIL-005
 *
 * Covers:
 *   1. PAGE_ROLES has exactly 6 items
 *   2. Each role has a non-empty canonical array
 *   3. Each role has an empty custom array by default
 *   4. PAGE_ROLE_DEFAULT_EVENT_CONFIG: exact canonical events per role
 *   5. PAGE_ROLE_BADGE_COLOR: each role maps to a CSS class string
 */

import { describe, expect, it } from 'vitest';
import {
  PAGE_ROLE_BADGE_COLOR,
  PAGE_ROLE_DEFAULT_EVENT_CONFIG,
  PAGE_ROLES,
} from '../../../../apps/control-plane/src/lib/page-role-defaults.js';

// ---------------------------------------------------------------------------
// Tests — PAGE_ROLES array
// ---------------------------------------------------------------------------

describe('PAGE_ROLES', () => {
  it('has exactly 6 roles', () => {
    expect(PAGE_ROLES).toHaveLength(6);
  });

  it('contains all expected roles', () => {
    const expected = [
      'capture',
      'sales',
      'checkout',
      'thankyou',
      'webinar',
      'survey',
    ] as const;
    for (const role of expected) {
      expect(PAGE_ROLES).toContain(role);
    }
  });

  it('contains no unexpected roles', () => {
    const knownRoles = new Set([
      'capture',
      'sales',
      'checkout',
      'thankyou',
      'webinar',
      'survey',
    ]);
    for (const role of PAGE_ROLES) {
      expect(knownRoles.has(role)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — PAGE_ROLE_DEFAULT_EVENT_CONFIG: custom always empty
// ---------------------------------------------------------------------------

describe('PAGE_ROLE_DEFAULT_EVENT_CONFIG — custom is empty for all roles', () => {
  for (const role of PAGE_ROLES) {
    it(`role "${role}" has empty custom array by default`, () => {
      const config = PAGE_ROLE_DEFAULT_EVENT_CONFIG[role];
      expect(config.custom).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests — PAGE_ROLE_DEFAULT_EVENT_CONFIG: canonical events per role
// ---------------------------------------------------------------------------

describe('PAGE_ROLE_DEFAULT_EVENT_CONFIG — canonical events per role', () => {
  it('capture: canonical = [PageView, Lead]', () => {
    const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG.capture;
    expect(canonical).toEqual(['PageView', 'Lead']);
  });

  it('sales: canonical = [PageView, ViewContent, InitiateCheckout]', () => {
    const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG.sales;
    expect(canonical).toEqual(['PageView', 'ViewContent', 'InitiateCheckout']);
  });

  it('checkout: canonical = [PageView, InitiateCheckout]', () => {
    const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG.checkout;
    expect(canonical).toEqual(['PageView', 'InitiateCheckout']);
  });

  it('thankyou: canonical = [PageView, Purchase]', () => {
    const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG.thankyou;
    expect(canonical).toEqual(['PageView', 'Purchase']);
  });

  it('webinar: canonical = [PageView, ViewContent]', () => {
    const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG.webinar;
    expect(canonical).toEqual(['PageView', 'ViewContent']);
  });

  it('survey: canonical = [PageView]', () => {
    const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG.survey;
    expect(canonical).toEqual(['PageView']);
  });

  it('every role has at least one canonical event', () => {
    for (const role of PAGE_ROLES) {
      const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG[role];
      expect(canonical.length).toBeGreaterThan(0);
    }
  });

  it('all canonical event names are non-empty strings', () => {
    for (const role of PAGE_ROLES) {
      const { canonical } = PAGE_ROLE_DEFAULT_EVENT_CONFIG[role];
      for (const name of canonical) {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — PAGE_ROLE_BADGE_COLOR
// ---------------------------------------------------------------------------

describe('PAGE_ROLE_BADGE_COLOR', () => {
  it('has a CSS class string for every role', () => {
    for (const role of PAGE_ROLES) {
      const cssClass = PAGE_ROLE_BADGE_COLOR[role];
      expect(typeof cssClass).toBe('string');
      expect(cssClass.length).toBeGreaterThan(0);
    }
  });

  it('capture badge color is set', () => {
    expect(PAGE_ROLE_BADGE_COLOR.capture).toBeTruthy();
  });

  it('sales badge color is set', () => {
    expect(PAGE_ROLE_BADGE_COLOR.sales).toBeTruthy();
  });

  it('checkout badge color is set', () => {
    expect(PAGE_ROLE_BADGE_COLOR.checkout).toBeTruthy();
  });

  it('thankyou badge color is set', () => {
    expect(PAGE_ROLE_BADGE_COLOR.thankyou).toBeTruthy();
  });

  it('webinar badge color is set', () => {
    expect(PAGE_ROLE_BADGE_COLOR.webinar).toBeTruthy();
  });

  it('survey badge color is set', () => {
    expect(PAGE_ROLE_BADGE_COLOR.survey).toBeTruthy();
  });

  it('all badge colors contain at least one Tailwind class segment', () => {
    for (const role of PAGE_ROLES) {
      const color = PAGE_ROLE_BADGE_COLOR[role];
      // Tailwind classes contain '-' and no spaces within a class
      expect(color).toMatch(/[a-z]+-[a-z0-9]+/);
    }
  });
});
