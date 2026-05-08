/**
 * Unit tests — lifecycle-rules.ts (pure domain rules, no I/O).
 *
 * BR-PRODUCT-001: hierarquia monotônica — promote nunca regride.
 * BR-PRODUCT-002: NULL category default to 'cliente'.
 *
 * T-PRODUCTS-002.
 */

import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
  PRODUCT_CATEGORIES,
  type ProductCategory,
  isLifecycleStatus,
  isProductCategory,
  lifecycleForCategory,
  lifecycleRank,
  promote,
} from '../../../apps/edge/src/lib/lifecycle-rules';

const WS = 'ws-00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// promote() — BR-PRODUCT-001 monotonicity
// ---------------------------------------------------------------------------

describe('promote (BR-PRODUCT-001)', () => {
  it('idempotent: promote(x, x) === x for every LifecycleStatus', () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(promote(status, status)).toBe(status);
    }
  });

  it('promotes contato → lead (rank 0 → 1)', () => {
    expect(promote('contato', 'lead')).toBe('lead');
  });

  it('promotes contato → mentorado (jump across ranks)', () => {
    expect(promote('contato', 'mentorado')).toBe('mentorado');
  });

  it('promotes lead → cliente', () => {
    expect(promote('lead', 'cliente')).toBe('cliente');
  });

  it('promotes lead → mentorado (multi-step jump)', () => {
    expect(promote('lead', 'mentorado')).toBe('mentorado');
  });

  it('promotes cliente → aluno', () => {
    expect(promote('cliente', 'aluno')).toBe('aluno');
  });

  it('promotes aluno → mentorado', () => {
    expect(promote('aluno', 'mentorado')).toBe('mentorado');
  });

  // ---- non-regression cases ----

  it('does NOT regress cliente → lead', () => {
    expect(promote('cliente', 'lead')).toBe('cliente');
  });

  it('does NOT regress aluno → cliente', () => {
    expect(promote('aluno', 'cliente')).toBe('aluno');
  });

  it('does NOT regress mentorado → aluno', () => {
    expect(promote('mentorado', 'aluno')).toBe('mentorado');
  });

  it('does NOT regress mentorado → contato (max → min)', () => {
    expect(promote('mentorado', 'contato')).toBe('mentorado');
  });

  it('does NOT regress lead → contato', () => {
    expect(promote('lead', 'contato')).toBe('lead');
  });

  // ---- exhaustive matrix: for any (a, b), result has rank == max(rank(a), rank(b)) ----

  it('exhaustive matrix: result rank == max(current_rank, candidate_rank)', () => {
    for (const current of LIFECYCLE_STATUSES) {
      for (const candidate of LIFECYCLE_STATUSES) {
        const expected =
          lifecycleRank(candidate) > lifecycleRank(current)
            ? candidate
            : current;
        expect(promote(current, candidate)).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// lifecycleForCategory() — BR-PRODUCT-002 + canonical mapping
// ---------------------------------------------------------------------------

describe('lifecycleForCategory', () => {
  it('NULL category → cliente (BR-PRODUCT-002 conservative default)', () => {
    expect(lifecycleForCategory(WS, null)).toBe('cliente');
  });

  it('low-ticket digital products map to cliente', () => {
    expect(lifecycleForCategory(WS, 'ebook')).toBe('cliente');
    expect(lifecycleForCategory(WS, 'workshop_online')).toBe('cliente');
    expect(lifecycleForCategory(WS, 'webinar')).toBe('cliente');
  });

  it('structured courses/training/events map to aluno', () => {
    expect(lifecycleForCategory(WS, 'curso_online')).toBe('aluno');
    expect(lifecycleForCategory(WS, 'curso_presencial')).toBe('aluno');
    expect(lifecycleForCategory(WS, 'pos_graduacao')).toBe('aluno');
    expect(lifecycleForCategory(WS, 'treinamento_online')).toBe('aluno');
    expect(lifecycleForCategory(WS, 'evento_fisico')).toBe('aluno');
  });

  it('mentoring/coaching products map to mentorado', () => {
    expect(lifecycleForCategory(WS, 'mentoria_individual')).toBe('mentorado');
    expect(lifecycleForCategory(WS, 'mentoria_grupo')).toBe('mentorado');
    expect(lifecycleForCategory(WS, 'acompanhamento_individual')).toBe(
      'mentorado',
    );
  });

  it('every ProductCategory has a mapping (no undefined results)', () => {
    for (const cat of PRODUCT_CATEGORIES) {
      const out = lifecycleForCategory(WS, cat);
      expect(LIFECYCLE_STATUSES).toContain(out);
    }
  });

  it('ignores workspaceId today (FUTURE-002 reserved): same result for any workspace', () => {
    expect(lifecycleForCategory('ws-A', 'curso_online')).toBe(
      lifecycleForCategory('ws-B', 'curso_online'),
    );
    expect(lifecycleForCategory('ws-A', null)).toBe(
      lifecycleForCategory('ws-B', null),
    );
  });
});

// ---------------------------------------------------------------------------
// lifecycleRank()
// ---------------------------------------------------------------------------

describe('lifecycleRank', () => {
  it('returns 0..4 in canonical order', () => {
    expect(lifecycleRank('contato')).toBe(0);
    expect(lifecycleRank('lead')).toBe(1);
    expect(lifecycleRank('cliente')).toBe(2);
    expect(lifecycleRank('aluno')).toBe(3);
    expect(lifecycleRank('mentorado')).toBe(4);
  });

  it('LIFECYCLE_STATUSES is sorted by rank ascending', () => {
    const ranks = LIFECYCLE_STATUSES.map(lifecycleRank);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('isLifecycleStatus', () => {
  it('accepts every canonical value', () => {
    for (const s of LIFECYCLE_STATUSES) {
      expect(isLifecycleStatus(s)).toBe(true);
    }
  });

  it('rejects non-canonical strings', () => {
    expect(isLifecycleStatus('customer')).toBe(false); // english variant
    expect(isLifecycleStatus('CONTATO')).toBe(false); // wrong case
    expect(isLifecycleStatus('')).toBe(false);
    expect(isLifecycleStatus('vip')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isLifecycleStatus(0)).toBe(false);
    expect(isLifecycleStatus(null)).toBe(false);
    expect(isLifecycleStatus(undefined)).toBe(false);
    expect(isLifecycleStatus({})).toBe(false);
    expect(isLifecycleStatus(['contato'])).toBe(false);
  });

  it('narrows the type when used in a conditional', () => {
    const v: unknown = 'aluno';
    if (isLifecycleStatus(v)) {
      const ls: LifecycleStatus = v; // type narrowed
      expect(ls).toBe('aluno');
    } else {
      throw new Error('unreachable');
    }
  });
});

describe('isProductCategory', () => {
  it('accepts every canonical category', () => {
    for (const c of PRODUCT_CATEGORIES) {
      expect(isProductCategory(c)).toBe(true);
    }
  });

  it('rejects non-canonical strings', () => {
    expect(isProductCategory('book')).toBe(false);
    expect(isProductCategory('Workshop_Online')).toBe(false); // wrong case
    expect(isProductCategory('')).toBe(false);
    expect(isProductCategory('mentoria')).toBe(false); // missing suffix
  });

  it('rejects non-strings', () => {
    expect(isProductCategory(null)).toBe(false);
    expect(isProductCategory(undefined)).toBe(false);
    expect(isProductCategory(42)).toBe(false);
    expect(isProductCategory({ category: 'ebook' })).toBe(false);
  });

  it('narrows the type when used in a conditional', () => {
    const v: unknown = 'ebook';
    if (isProductCategory(v)) {
      const c: ProductCategory = v; // type narrowed
      expect(c).toBe('ebook');
    } else {
      throw new Error('unreachable');
    }
  });
});
