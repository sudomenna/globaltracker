/**
 * Unit tests — FunnelBlueprintSchema
 *
 * T-ID: T-FUNIL-015 (Sprint 10 Phase 2)
 * BR-EVENT-001, INV-FUNNEL-001
 */

import { describe, expect, it } from 'vitest';
import { FunnelBlueprintSchema } from '../../../../packages/shared/src/schemas/funnel-blueprint.js';

const VALID_STAGE = {
  slug: 'lead_identified',
  label: 'Lead Identificado',
  is_recurring: false,
  source_events: ['Lead'],
};

const VALID_BLUEPRINT = {
  type: 'lancamento_gratuito' as const,
  has_main_offer: true,
  has_workshop: false,
  stages: [VALID_STAGE],
  pages: [],
  audiences: [],
};

describe('FunnelBlueprintSchema', () => {
  it('accepts a valid minimal blueprint', () => {
    expect(FunnelBlueprintSchema.safeParse(VALID_BLUEPRINT).success).toBe(true);
  });

  it('accepts a stage with source_event_filters', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      stages: [
        { ...VALID_STAGE, source_event_filters: { funnel_role: 'workshop' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a stage without label (label is required — rejects blank)', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      stages: [{ ...VALID_STAGE, label: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a stage with empty slug', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      stages: [{ ...VALID_STAGE, slug: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a stage with empty source_events array', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      stages: [{ ...VALID_STAGE, source_events: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts checkout_variant field', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      type: 'lancamento_pago',
      has_main_offer: true,
      checkout_variant: 'direto_guru',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown blueprint type', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      type: 'outro',
    });
    expect(result.success).toBe(false);
  });

  it('accepts is_recurring=true', () => {
    const result = FunnelBlueprintSchema.safeParse({
      ...VALID_BLUEPRINT,
      stages: [{ ...VALID_STAGE, is_recurring: true }],
    });
    expect(result.success).toBe(true);
  });
});
