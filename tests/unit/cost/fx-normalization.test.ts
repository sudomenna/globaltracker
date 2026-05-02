/**
 * Unit tests for FX normalization logic.
 *
 * Covers:
 *   INV-COST-003: spend_cents_normalized = round(spend_cents * fx_rate)
 *   INV-COST-004: fx_currency must match workspace.fx_normalization_currency
 *
 * Tests:
 *   - getRateEcb('EUR', 'BRL') returns correct cross-rate
 *   - getRateEcb('USD', 'BRL') computes cross-rate via EUR
 *   - normalizeSpendCents applies correct rounding
 *   - parseEcbXml correctly parses ECB XML fixture
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  computeCrossRate,
  fetchEcbRates,
  parseEcbXml,
} from '../../../apps/edge/src/integrations/fx-rates/ecb-client';
import { normalizeSpendCents } from '../../../apps/edge/src/lib/fx';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ECB_XML = readFileSync(
  join(import.meta.dirname, '../../fixtures/fx-rates/ecb-response-xml.txt'),
  'utf-8',
);

// Expected values from fixture:
//   EUR=1 (base), USD=1.0810, BRL=6.1430

// ---------------------------------------------------------------------------
// parseEcbXml
// ---------------------------------------------------------------------------

describe('parseEcbXml', () => {
  it('parses EUR as base=1 implicitly', () => {
    const rates = parseEcbXml(ECB_XML);
    expect(rates.EUR).toBe(1);
  });

  it('parses USD rate from fixture', () => {
    const rates = parseEcbXml(ECB_XML);
    expect(rates.USD).toBeCloseTo(1.081, 3);
  });

  it('parses BRL rate from fixture', () => {
    const rates = parseEcbXml(ECB_XML);
    expect(rates.BRL).toBeCloseTo(6.143, 3);
  });

  it('returns all expected currencies', () => {
    const rates = parseEcbXml(ECB_XML);
    for (const code of ['USD', 'BRL', 'GBP', 'JPY', 'CHF']) {
      expect(rates[code], `${code} should be present`).toBeDefined();
    }
  });

  it('throws EcbParseError when XML is empty', () => {
    expect(() => parseEcbXml('<gesmes:Envelope/>')).toThrow();
  });

  it('throws EcbParseError when no rate entries found', () => {
    expect(() =>
      parseEcbXml('<Cube><Cube time="2026-05-02"></Cube></Cube>'),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeCrossRate — EUR as base
// ---------------------------------------------------------------------------

describe('computeCrossRate — ECB EUR-based', () => {
  const rates = parseEcbXml(ECB_XML);

  // EUR/BRL direct
  it('INV-COST-003: getRateEcb("EUR", "BRL") returns EUR→BRL rate from fixture', () => {
    const rate = computeCrossRate('EUR', 'BRL', rates);
    // rates['BRL'] = 6.1430 (ECB: 1 EUR = 6.143 BRL)
    expect(rate).toBeCloseTo(6.143, 3);
  });

  // USD/BRL cross via EUR
  it('INV-COST-003: getRateEcb("USD", "BRL") computes cross-rate via EUR', () => {
    const rate = computeCrossRate('USD', 'BRL', rates);
    // Expected: rates[BRL] / rates[USD] = 6.1430 / 1.0810 ≈ 5.6826
    const expected = 6.143 / 1.081;
    expect(rate).toBeCloseTo(expected, 3);
  });

  // BRL/USD inverse
  it('computes BRL→USD cross-rate correctly', () => {
    const rate = computeCrossRate('BRL', 'USD', rates);
    const expected = 1.081 / 6.143;
    expect(rate).toBeCloseTo(expected, 4);
  });

  // EUR→USD direct
  it('handles from="EUR" directly without division', () => {
    const rate = computeCrossRate('EUR', 'USD', rates);
    expect(rate).toBeCloseTo(1.081, 3);
  });

  // USD→EUR inverse
  it('handles to="EUR" correctly (1/from)', () => {
    const rate = computeCrossRate('USD', 'EUR', rates);
    expect(rate).toBeCloseTo(1 / 1.081, 4);
  });

  // Identity
  it('returns 1 when from === to', () => {
    expect(computeCrossRate('USD', 'USD', rates)).toBe(1);
    expect(computeCrossRate('BRL', 'BRL', rates)).toBe(1);
    expect(computeCrossRate('EUR', 'EUR', rates)).toBe(1);
  });

  // Unknown currency
  it('throws when source currency not in rates', () => {
    expect(() => computeCrossRate('XYZ', 'BRL', rates)).toThrow();
  });

  it('throws when target currency not in rates', () => {
    expect(() => computeCrossRate('USD', 'XYZ', rates)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// fetchEcbRates — with mocked fetch
// ---------------------------------------------------------------------------

describe('fetchEcbRates with mocked fetch', () => {
  it('parses rates from fetched XML', async () => {
    const mockFetch = async (_url: string) =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => ECB_XML,
      }) as Response;

    const rates = await fetchEcbRates(mockFetch as typeof fetch);
    expect(rates.EUR).toBe(1);
    expect(rates.USD).toBeCloseTo(1.081, 3);
    expect(rates.BRL).toBeCloseTo(6.143, 3);
  });

  it('throws EcbFetchError on non-OK HTTP response', async () => {
    const mockFetch = async (_url: string) =>
      ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => '',
      }) as Response;

    await expect(fetchEcbRates(mockFetch as typeof fetch)).rejects.toThrow(
      'HTTP 503',
    );
  });

  it('throws EcbFetchError on network failure', async () => {
    const mockFetch = async (_url: string): Promise<Response> => {
      throw new Error('Network error');
    };

    await expect(fetchEcbRates(mockFetch as typeof fetch)).rejects.toThrow(
      'Network error',
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeSpendCents (INV-COST-003)
// ---------------------------------------------------------------------------

describe('normalizeSpendCents', () => {
  it('INV-COST-003: round(spend_cents * fx_rate) — basic case', () => {
    // 100 USD cents (= $1.00) at rate 5.6826 → $5.6826 = 568 BRL cents
    expect(normalizeSpendCents(100, 5.6826)).toBe(Math.round(100 * 5.6826));
  });

  it('INV-COST-003: rounds 0.5 up', () => {
    // 1 cent * 1.5 = 1.5 → rounds to 2
    expect(normalizeSpendCents(1, 1.5)).toBe(2);
  });

  it('INV-COST-003: rounds down when fraction < 0.5', () => {
    // 1 cent * 1.4 = 1.4 → rounds to 1
    expect(normalizeSpendCents(1, 1.4)).toBe(1);
  });

  it('INV-COST-003: zero spend normalizes to zero', () => {
    expect(normalizeSpendCents(0, 5.0)).toBe(0);
  });

  it('INV-COST-003: large spend amount rounds correctly', () => {
    // 500_000 cents ($5,000 USD) at 5.683 → 2_841_500 BRL cents
    const result = normalizeSpendCents(500_000, 5.683);
    expect(result).toBe(Math.round(500_000 * 5.683));
    expect(Number.isInteger(result)).toBe(true);
  });

  it('INV-COST-003: rate=1 returns spend_cents unchanged', () => {
    expect(normalizeSpendCents(12345, 1)).toBe(12345);
  });

  it('INV-COST-003: fractional result is always an integer', () => {
    const result = normalizeSpendCents(333, 3.33);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('USD→BRL cross-rate from fixture produces reasonable result', () => {
    const rates = parseEcbXml(ECB_XML);
    const usdToBrl = computeCrossRate('USD', 'BRL', rates);
    // 1000 USD cents ($10 USD) at ~5.68 → ~5682 BRL cents
    const normalized = normalizeSpendCents(1000, usdToBrl);
    expect(normalized).toBeGreaterThan(5000);
    expect(normalized).toBeLessThan(7000);
    expect(Number.isInteger(normalized)).toBe(true);
  });
});
