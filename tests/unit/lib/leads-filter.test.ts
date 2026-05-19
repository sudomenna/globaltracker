/**
 * Unit tests — leads-filter.ts (buildTagFilterWhere).
 *
 * T-TAGS-008 (test author) cobrindo o builder de T-TAGS-003a.
 *
 * Verifica:
 *   - Retorna null em filter vazio (undefined, null, clauses=[]).
 *   - AND/OR montados corretamente (separador no fragment).
 *   - EXISTS para has=true, NOT EXISTS para has=false.
 *   - SEM JOIN — apenas subqueries (defesa contra "Join multiplication bug",
 *     ver MEMORY.md).
 *   - workspace_id explicitamente parametrizado dentro de cada subquery
 *     (BR-IDENTITY).
 *
 * Inspeção do fragment SQL: Drizzle `sql` template expõe `queryChunks`
 * alternando entre literais (`{ value: [str] }`) e params (valores bare).
 * `flatLiterals(...)` extrai SÓ o texto SQL — params como workspace_id ou
 * tag.tag NÃO aparecem no resultado, o que comprova que estão sendo
 * parametrizados (anti-SQL-injection).
 */

import { describe, expect, it } from 'vitest';
import {
  buildTagFilterWhere,
  type TagFilter,
} from '../../../apps/edge/src/lib/leads-filter';

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001';

/**
 * Extract concatenated SQL literal text from a Drizzle fragment, ignoring
 * interpolated params. Walks `queryChunks` recursively: nodes with shape
 * `{ value: [str] }` are literal SQL; nested `{ queryChunks: [...] }` nodes
 * recurse; bare strings/numbers are PARAMS and skipped.
 */
function flatLiterals(fragment: unknown): string {
  const out: string[] = [];
  function walk(node: unknown): void {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === 'object') {
      const obj = node as { value?: unknown; queryChunks?: unknown };
      if (Array.isArray(obj.value)) {
        for (const v of obj.value) {
          if (typeof v === 'string') out.push(v);
        }
      }
      if (Array.isArray(obj.queryChunks)) {
        walk(obj.queryChunks);
      }
    }
    // bare values (strings/numbers) = params; ignorados aqui.
  }
  const chunks =
    (fragment as { queryChunks?: unknown[] })?.queryChunks ?? [];
  walk(chunks);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Empty-filter cases — retorna null
// ---------------------------------------------------------------------------

describe('buildTagFilterWhere — empty filter', () => {
  it('returns null when filter is undefined', () => {
    expect(buildTagFilterWhere(undefined, WORKSPACE_ID)).toBeNull();
  });

  it('returns null when filter is null', () => {
    expect(buildTagFilterWhere(null, WORKSPACE_ID)).toBeNull();
  });

  it('returns null when clauses array is empty', () => {
    const filter: TagFilter = { op: 'and', clauses: [] };
    expect(buildTagFilterWhere(filter, WORKSPACE_ID)).toBeNull();
  });

  it('returns null also when op="or" + clauses vazias', () => {
    const filter: TagFilter = { op: 'or', clauses: [] };
    expect(buildTagFilterWhere(filter, WORKSPACE_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single clause — EXISTS vs NOT EXISTS
// ---------------------------------------------------------------------------

describe('buildTagFilterWhere — single clause shape', () => {
  it('has=true → EXISTS, SEM JOIN, workspace_id anchor (BR-IDENTITY)', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [{ has: true, tag: 'wpp_joined' }],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    expect(fragment).not.toBeNull();

    const sqlText = flatLiterals(fragment);
    expect(sqlText).toContain('EXISTS (');
    expect(sqlText).not.toContain('NOT EXISTS');
    expect(sqlText).toContain('SELECT 1 FROM lead_tags');
    expect(sqlText).toContain('lead_tags.workspace_id');
    expect(sqlText).toContain('lead_tags.tag_name');
    // Defesa anti-Join multiplication: NÃO deve aparecer JOIN.
    expect(sqlText.toUpperCase()).not.toContain(' JOIN ');
  });

  it('has=false → NOT EXISTS, SEM JOIN', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [{ has: false, tag: 'excluded_tag' }],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);

    expect(sqlText).toContain('NOT EXISTS (');
    expect(sqlText).toContain('SELECT 1 FROM lead_tags');
    expect(sqlText.toUpperCase()).not.toContain(' JOIN ');
  });
});

// ---------------------------------------------------------------------------
// Multi-clause — AND vs OR combiner
// ---------------------------------------------------------------------------
//
// Cada subquery interna contém "AND" entre seus filtros WHERE
// (lead_id = ... AND workspace_id = ... AND tag_name = ...).
// Contagem esperada de ' AND ' no texto literal:
//   - N clauses, op='and': 2*N (internos) + (N-1) (separadores) = 3N - 1
//   - N clauses, op='or':  2*N (internos)
// Contagem esperada de ' OR ':
//   - N clauses, op='or':  (N-1)
//   - op='and':            0

describe('buildTagFilterWhere — combinator AND/OR', () => {
  function countSubstring(haystack: string, needle: string): number {
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
      count++;
      idx += needle.length;
    }
    return count;
  }

  it('op="and" + 2 clauses: 2 EXISTS, separador AND no top-level', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [
        { has: true, tag: 'tag_a' },
        { has: true, tag: 'tag_b' },
      ],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);

    expect(countSubstring(sqlText, 'EXISTS (')).toBe(2);
    expect(countSubstring(sqlText, 'NOT EXISTS')).toBe(0);
    // 2 clauses × 2 ANDs internos + 1 separador AND = 5 ocorrências.
    expect(countSubstring(sqlText, ' AND ')).toBe(5);
    expect(countSubstring(sqlText, ' OR ')).toBe(0);
  });

  it('op="or" + 2 clauses: 2 EXISTS, separador OR no top-level (nenhum AND extra)', () => {
    const filter: TagFilter = {
      op: 'or',
      clauses: [
        { has: true, tag: 'tag_a' },
        { has: true, tag: 'tag_b' },
      ],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);

    expect(countSubstring(sqlText, 'EXISTS (')).toBe(2);
    // 2 clauses × 2 ANDs internos + 0 separadores AND = 4 ocorrências.
    expect(countSubstring(sqlText, ' AND ')).toBe(4);
    // 1 separador OR.
    expect(countSubstring(sqlText, ' OR ')).toBe(1);
  });

  it('op="and" misto has=true + has=false → 1 EXISTS + 1 NOT EXISTS', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [
        { has: true, tag: 'must_have' },
        { has: false, tag: 'must_not_have' },
      ],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);

    // 'EXISTS (' aparece em ambos (NOT EXISTS contém EXISTS) → 2 ocorrências.
    expect(countSubstring(sqlText, 'EXISTS (')).toBe(2);
    expect(countSubstring(sqlText, 'NOT EXISTS')).toBe(1);
    expect(sqlText.toUpperCase()).not.toContain(' JOIN ');
  });

  it('3 clauses op="or": 2 separadores OR', () => {
    const filter: TagFilter = {
      op: 'or',
      clauses: [
        { has: true, tag: 'a' },
        { has: true, tag: 'b' },
        { has: true, tag: 'c' },
      ],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);

    expect(countSubstring(sqlText, 'EXISTS (')).toBe(3);
    expect(countSubstring(sqlText, ' OR ')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// leadIdColumn default
// ---------------------------------------------------------------------------

describe('buildTagFilterWhere — leadIdColumn default', () => {
  it('usa "leads.id" por default quando leadIdColumn não fornecido', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [{ has: true, tag: 'x' }],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);
    expect(sqlText).toContain('leads.id');
  });

  // NOTE: testar leadIdColumn customizado requer importar `sql` de drizzle-orm,
  // que não é resolvable do diretório `tests/` (apenas de `apps/edge`).
  // O caller real (`leads-queries.ts:593,759,834`) já passa `sql\`${leads.id}\``;
  // a integração é coberta indiretamente via testes de leads-queries / E2E.
});

// ---------------------------------------------------------------------------
// Anti-regressão: workspace_id e tag são PARAMS (não literais)
// ---------------------------------------------------------------------------

describe('buildTagFilterWhere — parametrização (anti-injection)', () => {
  it('workspace_id NÃO aparece em literal SQL (chega como ::uuid param)', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [{ has: true, tag: 'x' }],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);

    // Valor do workspace_id chega via drizzle param binding; não pode vazar
    // pro texto literal SQL.
    expect(sqlText).not.toContain(WORKSPACE_ID);
    // Mas o cast `::uuid` está presente como literal.
    expect(sqlText).toContain('::uuid');
  });

  it('tag.tag NÃO aparece em literal SQL (é param)', () => {
    const filter: TagFilter = {
      op: 'and',
      clauses: [{ has: true, tag: 'sentinel_tag_value_12345' }],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);
    expect(sqlText).not.toContain('sentinel_tag_value_12345');
  });

  it('tentativa de injection (` OR 1=1 --`) entra como param, não como literal SQL', () => {
    // Defesa anti-injection: mesmo se a UI passar valor malicioso, o drizzle
    // bind impede que vire SQL executável.
    const malicious = "x' OR 1=1 --";
    const filter: TagFilter = {
      op: 'and',
      clauses: [{ has: true, tag: malicious }],
    };

    const fragment = buildTagFilterWhere(filter, WORKSPACE_ID);
    const sqlText = flatLiterals(fragment);
    expect(sqlText).not.toContain(malicious);
  });
});
