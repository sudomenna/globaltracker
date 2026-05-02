/**
 * Unit tests — INV-AUDIENCE-007: AudienceQueryDefinitionSchema validates DSL
 *
 * Ensures that the Zod schema correctly accepts valid DSLs and rejects invalid ones.
 *
 * INV-AUDIENCE-007: query_definition must be a builder DSL with at least one condition.
 * BR-AUDIENCE-003: query_definition is a structured DSL — no free-form SQL.
 */

import { describe, expect, it } from 'vitest';
import {
  AudienceQueryConditionSchema,
  AudienceQueryDefinitionSchema,
} from '../../../apps/edge/src/lib/audience';

// ---------------------------------------------------------------------------
// AudienceQueryDefinitionSchema
// ---------------------------------------------------------------------------

describe('INV-AUDIENCE-007: AudienceQueryDefinitionSchema DSL validation', () => {
  it('accepts a valid DSL with type=builder and a stage condition', () => {
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
      all: [{ stage: 'registered' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid DSL with multiple AND conditions (stage + is_icp)', () => {
    // INV-AUDIENCE-007: multiple conditions are ANDed
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
      all: [{ stage: 'registered' }, { is_icp: true }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid DSL with purchased=true condition', () => {
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
      all: [{ purchased: true }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid DSL with not_stage condition', () => {
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
      all: [{ not_stage: 'unsubscribed' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type (not "builder")', () => {
    // INV-AUDIENCE-007: type must be the literal 'builder'
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'sql',
      all: [{ stage: 'registered' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = AudienceQueryDefinitionSchema.safeParse({
      all: [{ stage: 'registered' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects all=[]: array must have at least one condition', () => {
    // INV-AUDIENCE-007: at least one condition required
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
      all: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects condition with no recognized fields (empty object)', () => {
    // BR-AUDIENCE-003: each condition must have at least one field
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
      all: [{}],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing all field entirely', () => {
    const result = AudienceQueryDefinitionSchema.safeParse({
      type: 'builder',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AudienceQueryConditionSchema
// ---------------------------------------------------------------------------

describe('AudienceQueryConditionSchema condition validation', () => {
  it('accepts condition with stage only', () => {
    const result = AudienceQueryConditionSchema.safeParse({
      stage: 'lead_identified',
    });
    expect(result.success).toBe(true);
  });

  it('accepts condition with is_icp=false', () => {
    const result = AudienceQueryConditionSchema.safeParse({ is_icp: false });
    expect(result.success).toBe(true);
  });

  it('accepts condition with multiple recognized fields', () => {
    const result = AudienceQueryConditionSchema.safeParse({
      stage: 'registered',
      is_icp: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty object condition — must have at least one field', () => {
    const result = AudienceQueryConditionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
