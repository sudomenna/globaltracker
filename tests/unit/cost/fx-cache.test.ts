/**
 * Unit tests for FX cache layer and getRateForPair flow.
 *
 * Covers:
 *   - Cache miss → provider is called
 *   - Cache hit → provider is NOT called
 *   - Stale fallback when provider fails after retries
 *   - FxRatesUnavailableError when both provider and stale fail
 *   - getCachedRate / setCachedRate / getStaleCachedRate contract
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildCacheKey,
  buildStaleCacheKey,
  getCachedRate,
  getStaleCachedRate,
  setCachedRate,
} from '../../../apps/edge/src/integrations/fx-rates/cache';
import {
  FxRatesUnavailableError,
  getRateForPair,
} from '../../../apps/edge/src/lib/fx';

// ---------------------------------------------------------------------------
// KV mock helpers
// ---------------------------------------------------------------------------

function makeMockKv(
  initial: Record<string, string> = {},
): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));

  const kv = {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(
      key: string,
      value: string,
      _opts?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, value);
    },
    // Satisfy KVNamespace interface for remaining methods (unused in tests)
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<KVNamespaceListResult<unknown, string>> {
      return {
        keys: [],
        list_complete: true,
        curs: '',
      } as unknown as KVNamespaceListResult<unknown, string>;
    },
    async getWithMetadata(): Promise<
      KVNamespaceGetWithMetadataResult<string, unknown>
    > {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace & { store: Map<string, string> };

  return kv;
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

describe('buildCacheKey', () => {
  it('normalises currencies to uppercase', () => {
    expect(buildCacheKey('ecb', 'usd', 'brl', '2026-05-02')).toBe(
      'fx:ecb:USD-BRL:2026-05-02',
    );
  });

  it('uses expected format: fx:{provider}:{from}-{to}:{date}', () => {
    expect(buildCacheKey('wise', 'USD', 'BRL', '2026-05-01')).toBe(
      'fx:wise:USD-BRL:2026-05-01',
    );
  });
});

describe('buildStaleCacheKey', () => {
  it('uses expected format: fx_stale:{provider}:{from}-{to}', () => {
    expect(buildStaleCacheKey('ecb', 'USD', 'BRL')).toBe(
      'fx_stale:ecb:USD-BRL',
    );
  });

  it('normalises currencies to uppercase', () => {
    expect(buildStaleCacheKey('ecb', 'usd', 'brl')).toBe(
      'fx_stale:ecb:USD-BRL',
    );
  });
});

// ---------------------------------------------------------------------------
// getCachedRate / setCachedRate / getStaleCachedRate
// ---------------------------------------------------------------------------

describe('getCachedRate', () => {
  it('returns null on cache miss', async () => {
    const kv = makeMockKv();
    const result = await getCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02');
    expect(result).toBeNull();
  });

  it('returns the cached rate after set', async () => {
    const kv = makeMockKv();
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02', 5.683);
    const result = await getCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02');
    expect(result).toBeCloseTo(5.683, 4);
  });

  it('returns null for a different date', async () => {
    const kv = makeMockKv();
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02', 5.683);
    const result = await getCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-01');
    expect(result).toBeNull();
  });

  it('returns null for a different pair', async () => {
    const kv = makeMockKv();
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02', 5.683);
    const result = await getCachedRate(kv, 'ecb', 'EUR', 'BRL', '2026-05-02');
    expect(result).toBeNull();
  });
});

describe('setStaleCachedRate (via setCachedRate)', () => {
  it('getStaleCachedRate returns null before any set', async () => {
    const kv = makeMockKv();
    const result = await getStaleCachedRate(kv, 'ecb', 'USD', 'BRL');
    expect(result).toBeNull();
  });

  it('getStaleCachedRate returns rate after setCachedRate', async () => {
    const kv = makeMockKv();
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02', 5.683);
    const result = await getStaleCachedRate(kv, 'ecb', 'USD', 'BRL');
    expect(result).toBeCloseTo(5.683, 4);
  });

  it('stale key has no date component (persists across dates)', async () => {
    const kv = makeMockKv();
    // Write for day 1
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-01', 5.5);
    // Write for day 2 with different rate
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02', 5.68);
    // Stale key should have day 2's rate (last written)
    const stale = await getStaleCachedRate(kv, 'ecb', 'USD', 'BRL');
    expect(stale).toBeCloseTo(5.68, 3);
  });
});

// ---------------------------------------------------------------------------
// getRateForPair — integration of cache + provider
// ---------------------------------------------------------------------------

const ECB_XML_MINIMAL = `<?xml version="1.0"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time="2026-05-02">
      <Cube currency="USD" rate="1.0810"/>
      <Cube currency="BRL" rate="6.1430"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const mockEcbFetch = async (_url: string) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => ECB_XML_MINIMAL,
  }) as Response;

describe('getRateForPair — cache miss → provider called', () => {
  it('calls provider when KV cache is empty and returns fresh rate', async () => {
    const kv = makeMockKv();
    const providerCalls: string[] = [];

    const instrumentedFetch = async (url: string) => {
      providerCalls.push(url as string);
      return mockEcbFetch(url);
    };

    const result = await getRateForPair(
      'USD',
      'BRL',
      '2026-05-02',
      { GT_KV: kv, FX_RATES_PROVIDER: 'ecb' },
      instrumentedFetch as typeof fetch,
      async () => {}, // no-op sleep
    );

    expect(result.stale).toBe(false);
    expect(result.source).toBe('ecb');
    expect(result.rate).toBeGreaterThan(0);
    expect(providerCalls.length).toBe(1);
  });

  it('stores fresh rate in KV after provider success', async () => {
    const kv = makeMockKv();

    await getRateForPair(
      'USD',
      'BRL',
      '2026-05-02',
      { GT_KV: kv, FX_RATES_PROVIDER: 'ecb' },
      mockEcbFetch as typeof fetch,
      async () => {},
    );

    const cached = await getCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02');
    expect(cached).not.toBeNull();
    expect(cached).toBeGreaterThan(0);
  });
});

describe('getRateForPair — cache hit → provider NOT called', () => {
  it('returns cached rate without calling provider', async () => {
    const kv = makeMockKv();
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-02', 5.683);

    const providerCalls: string[] = [];
    const trackingFetch = async (url: string) => {
      providerCalls.push(url as string);
      return mockEcbFetch(url);
    };

    const result = await getRateForPair(
      'USD',
      'BRL',
      '2026-05-02',
      { GT_KV: kv, FX_RATES_PROVIDER: 'ecb' },
      trackingFetch as typeof fetch,
      async () => {},
    );

    expect(result.stale).toBe(false);
    expect(result.rate).toBeCloseTo(5.683, 4);
    expect(providerCalls.length).toBe(0); // no provider call
  });
});

describe('getRateForPair — stale fallback when provider fails', () => {
  it('returns stale=true when provider always throws but stale key exists', async () => {
    const kv = makeMockKv();
    // Pre-populate stale key with a previous rate
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-01', 5.5);

    const failingFetch = async (): Promise<Response> => {
      throw new Error('ECB unavailable');
    };

    const result = await getRateForPair(
      'USD',
      'BRL',
      '2026-05-02', // different date so primary cache misses
      { GT_KV: kv, FX_RATES_PROVIDER: 'ecb' },
      failingFetch as typeof fetch,
      async () => {}, // no-op sleep for fast tests
    );

    expect(result.stale).toBe(true);
    expect(result.rate).toBeCloseTo(5.5, 3);
    expect(result.source).toBe('ecb');
  });

  it('attempts provider MAX_RETRIES (3) times before stale fallback', async () => {
    const kv = makeMockKv();
    await setCachedRate(kv, 'ecb', 'USD', 'BRL', '2026-05-01', 5.5);

    let callCount = 0;
    const failingFetch = async (): Promise<Response> => {
      callCount++;
      throw new Error('ECB unavailable');
    };

    await getRateForPair(
      'USD',
      'BRL',
      '2026-05-02',
      { GT_KV: kv, FX_RATES_PROVIDER: 'ecb' },
      failingFetch as typeof fetch,
      async () => {},
    );

    expect(callCount).toBe(3);
  });
});

describe('getRateForPair — FxRatesUnavailableError', () => {
  it('throws FxRatesUnavailableError when provider fails and no stale available', async () => {
    const kv = makeMockKv(); // empty KV — no stale

    const failingFetch = async (): Promise<Response> => {
      throw new Error('ECB unavailable');
    };

    await expect(
      getRateForPair(
        'USD',
        'BRL',
        '2026-05-02',
        { GT_KV: kv, FX_RATES_PROVIDER: 'ecb' },
        failingFetch as typeof fetch,
        async () => {},
      ),
    ).rejects.toThrow(FxRatesUnavailableError);
  });

  it('FxRatesUnavailableError message includes from/to/date', async () => {
    const kv = makeMockKv();

    const failingFetch = async (): Promise<Response> => {
      throw new Error('timeout');
    };

    try {
      await getRateForPair(
        'USD',
        'BRL',
        '2026-05-02',
        { GT_KV: kv },
        failingFetch as typeof fetch,
        async () => {},
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FxRatesUnavailableError);
      const fxErr = err as FxRatesUnavailableError;
      expect(fxErr.from).toBe('USD');
      expect(fxErr.to).toBe('BRL');
      expect(fxErr.date).toBe('2026-05-02');
    }
  });
});

describe('getRateForPair — defaults to ecb when FX_RATES_PROVIDER is unset', () => {
  it('uses ecb provider when env has no FX_RATES_PROVIDER', async () => {
    const kv = makeMockKv();

    const result = await getRateForPair(
      'USD',
      'BRL',
      '2026-05-02',
      { GT_KV: kv }, // no FX_RATES_PROVIDER
      mockEcbFetch as typeof fetch,
      async () => {},
    );

    expect(result.source).toBe('ecb');
    expect(result.stale).toBe(false);
    expect(result.rate).toBeGreaterThan(0);
  });
});
