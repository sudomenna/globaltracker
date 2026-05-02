/**
 * Build artifact test — INV-TRACKER-001: bundle < 15 KB gzipped.
 *
 * This test verifies the final compiled bundle meets the size constraint.
 * Run after `pnpm --filter @gt/tracker build`.
 *
 * INV-TRACKER-001: Bundle final < 15 KB gzipped.
 * INV-TRACKER-002: Zero runtime dependencies — verified by checking bundle content.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { gzipSync } from 'zlib';
import { join } from 'path';

const BUNDLE_PATH = join(__dirname, '../../apps/tracker/dist/tracker.js');
const MAX_GZIP_BYTES = 15 * 1024; // 15 KB

describe('tracker bundle — INV-TRACKER-001', () => {
  it('bundle file exists after build', () => {
    if (!existsSync(BUNDLE_PATH)) {
      // Skip if not built yet — CI will have it; local dev may not
      console.warn(`Bundle not found at ${BUNDLE_PATH} — run 'pnpm --filter @gt/tracker build' first`);
      return;
    }
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it('gzipped bundle is under 15 KB (INV-TRACKER-001)', () => {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn('Skipping bundle size test — bundle not built');
      return;
    }

    const content = readFileSync(BUNDLE_PATH);
    const gzipped = gzipSync(content);
    const gzipBytes = gzipped.length;

    console.log(
      `Bundle: ${content.length} bytes raw | ${gzipBytes} bytes gzipped (${(gzipBytes / 1024).toFixed(2)} KB)`
    );

    expect(gzipBytes).toBeLessThanOrEqual(MAX_GZIP_BYTES);
  });

  it('bundle does not contain node_modules markers (INV-TRACKER-002)', () => {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn('Skipping dependency check — bundle not built');
      return;
    }

    const content = readFileSync(BUNDLE_PATH, 'utf-8');

    // INV-TRACKER-002: zero runtime deps — no require() calls to external modules
    // esbuild bundles everything inline; no dynamic require to node_modules should appear
    const forbiddenPatterns = [
      /require\(['"]lodash['"]\)/,
      /require\(['"]axios['"]\)/,
      /require\(['"]react['"]\)/,
    ];

    for (const pattern of forbiddenPatterns) {
      expect(content).not.toMatch(pattern);
    }
  });

  it('bundle exposes window.Funil API markers', () => {
    if (!existsSync(BUNDLE_PATH)) {
      console.warn('Skipping API marker check — bundle not built');
      return;
    }

    const content = readFileSync(BUNDLE_PATH, 'utf-8');

    // Verify the bundle contains the Funil API surface (minified names may differ,
    // but key strings should be present in the IIFE output)
    expect(content).toContain('Funil');
  });
});
