/**
 * jsonb-unwrap.ts — Test helper to unwrap SQL fragments produced by jsonb().
 *
 * Context: `apps/edge/src/lib/jsonb-cast.ts` exports `jsonb(value)` which wraps
 * a JS value as a Drizzle `SQL` fragment using dollar-quoted syntax:
 *
 *   `$gtjsonb$<json>$gtjsonb$::jsonb`
 *
 * This is required because the Hyperdrive driver does not implicitly cast text
 * to jsonb on insert. In production the cast resolves at the Postgres parser
 * stage and the column receives a proper jsonb-object.
 *
 * In tests with mock DBs, the `.values()` callback receives the SQL fragment
 * literally instead of the wrapped JS value. This helper extracts the original
 * value back so existing test assertions on plain objects keep working.
 *
 * Usage:
 *   import { unwrapJsonbValues } from '../../helpers/jsonb-unwrap.js';
 *   const captured = unwrapJsonbValues(values);
 *   expect(captured.payload).toMatchObject({ ... });
 */

const TAG = '$gtjsonb';

/**
 * Returns true if the value looks like a Drizzle `SQL` fragment produced by
 * the `jsonb()` helper. Detection is based on the dollar tag prefix.
 */
function isJsonbSqlFragment(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  // Drizzle SQL fragments expose `queryChunks` (array of strings/params).
  const chunks = (value as { queryChunks?: unknown }).queryChunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return false;
  // sql.raw() wraps the raw string into a single chunk that has `.value` array.
  const first = chunks[0] as { value?: string[] } | string;
  const text =
    typeof first === 'string'
      ? first
      : Array.isArray(first?.value)
        ? first.value.join('')
        : '';
  return text.includes(TAG);
}

/**
 * Extracts the underlying JS value from a `jsonb(...)` SQL fragment.
 * Returns the input unchanged when it is not a recognized SQL fragment.
 */
export function unwrapJsonb(value: unknown): unknown {
  if (!isJsonbSqlFragment(value)) return value;
  const chunks = (value as { queryChunks: unknown[] }).queryChunks;
  const first = chunks[0] as { value?: string[] } | string;
  const text =
    typeof first === 'string'
      ? first
      : Array.isArray(first?.value)
        ? first.value.join('')
        : '';
  // Match either default tag or random fallback (gtjsonb_<random>).
  const match = text.match(
    /\$gtjsonb[a-z0-9_]*\$([\s\S]*)\$gtjsonb[a-z0-9_]*\$::jsonb/,
  );
  if (!match || match[1] === undefined) return value;
  try {
    return JSON.parse(match[1]);
  } catch {
    return value;
  }
}

/**
 * Returns a shallow-copy of `values` with every jsonb SQL fragment unwrapped
 * back to its plain JS form. Other fields pass through unchanged.
 */
export function unwrapJsonbValues<T extends Record<string, unknown>>(
  values: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = unwrapJsonb(v);
  }
  return out as T;
}
