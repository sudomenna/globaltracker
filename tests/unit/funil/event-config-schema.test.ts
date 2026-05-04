/**
 * Unit tests — packages/shared/src/schemas/event-config.ts
 *
 * T-ID: T-FUNIL-005
 *
 * Covers:
 *   1. Accepts valid object with canonical and custom arrays
 *   2. Accepts custom events with non-empty strings (e.g. custom: prefixed)
 *   3. Rejects canonical with empty string
 *   4. Rejects custom with empty string
 *   5. Rejects object missing canonical key
 *   6. Rejects object missing custom key
 *   7. Rejects non-array values for canonical or custom
 */

import { describe, expect, it } from 'vitest';
import { EventConfigSchema } from '../../../packages/shared/src/schemas/event-config.js';

// ---------------------------------------------------------------------------
// Valid cases
// ---------------------------------------------------------------------------

describe('EventConfigSchema — valid inputs', () => {
  it('accepts { canonical: [PageView, Lead], custom: [] }', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView', 'Lead'],
      custom: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts canonical with a single event', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView'],
      custom: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom with non-empty string values', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView'],
      custom: ['custom:add_to_cart', 'custom:form_submit'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts both canonical and custom non-empty', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView', 'Lead'],
      custom: ['custom:quiz_complete'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom with arbitrary non-empty string (no prefix requirement in schema)', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView'],
      custom: ['my_custom_event'],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid cases — empty strings
// ---------------------------------------------------------------------------

describe('EventConfigSchema — rejects empty strings', () => {
  it('rejects canonical containing an empty string', () => {
    const result = EventConfigSchema.safeParse({
      canonical: [''],
      custom: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.canonical).toBeDefined();
    }
  });

  it('rejects canonical with mixed valid and empty string', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView', ''],
      custom: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects custom containing an empty string', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView'],
      custom: [''],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.custom).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid cases — missing keys
// ---------------------------------------------------------------------------

describe('EventConfigSchema — rejects missing required keys', () => {
  it('rejects object without canonical key', () => {
    const result = EventConfigSchema.safeParse({
      custom: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.canonical).toBeDefined();
    }
  });

  it('rejects object without custom key', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.custom).toBeDefined();
    }
  });

  it('rejects empty object {}', () => {
    const result = EventConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid cases — wrong types
// ---------------------------------------------------------------------------

describe('EventConfigSchema — rejects wrong types', () => {
  it('rejects canonical as string instead of array', () => {
    const result = EventConfigSchema.safeParse({
      canonical: 'PageView',
      custom: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects custom as string instead of array', () => {
    const result = EventConfigSchema.safeParse({
      canonical: ['PageView'],
      custom: 'my_event',
    });
    expect(result.success).toBe(false);
  });

  it('rejects null input', () => {
    const result = EventConfigSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});
