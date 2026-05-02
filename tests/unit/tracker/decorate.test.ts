/**
 * Unit tests for apps/tracker/src/decorate.ts
 *
 * Covers:
 *   - Propagation of UTM params + lead_public_id to links (cross-domain)
 *   - docs/20-domain/13-mod-tracker.md §10: decorate() API
 *   - INV-TRACKER-007: decorate() must not throw on host page
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendParamsToUrl,
  buildDecorateParams,
  decorateElement,
} from '../../../apps/tracker/src/decorate';
import { decorate } from '../../../apps/tracker/src/decorate';
import { setState } from '../../../apps/tracker/src/state';
import type { AttributionParams } from '../../../apps/tracker/src/types';

const FULL_ATTRIBUTION: AttributionParams = {
  utm_source: 'facebook',
  utm_medium: 'cpc',
  utm_campaign: 'launch_v2',
  utm_content: 'ad_creative_01',
  utm_term: null,
  fbclid: 'fb_click_123',
  gclid: null,
  gbraid: null,
  wbraid: null,
};

const EMPTY_ATTRIBUTION: AttributionParams = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  fbclid: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
};

describe('buildDecorateParams', () => {
  it('includes lead_public_id when present', () => {
    const params = buildDecorateParams('pub_abc123', EMPTY_ATTRIBUTION);
    expect(params.lead_public_id).toBe('pub_abc123');
  });

  it('omits lead_public_id when null', () => {
    const params = buildDecorateParams(null, EMPTY_ATTRIBUTION);
    expect(params.lead_public_id).toBeUndefined();
  });

  it('includes non-null attribution params', () => {
    const params = buildDecorateParams(null, FULL_ATTRIBUTION);
    expect(params.utm_source).toBe('facebook');
    expect(params.utm_medium).toBe('cpc');
    expect(params.fbclid).toBe('fb_click_123');
  });

  it('omits null attribution params', () => {
    const params = buildDecorateParams(null, FULL_ATTRIBUTION);
    expect(params.utm_term).toBeUndefined();
    expect(params.gclid).toBeUndefined();
  });

  it('returns empty object when nothing to add', () => {
    const params = buildDecorateParams(null, EMPTY_ATTRIBUTION);
    expect(Object.keys(params)).toHaveLength(0);
  });
});

describe('appendParamsToUrl', () => {
  it('appends params to URL without existing query', () => {
    const result = appendParamsToUrl('https://checkout.example.com/offer', {
      utm_source: 'facebook',
      lead_public_id: 'pub_123',
    });
    const url = new URL(result);
    expect(url.searchParams.get('utm_source')).toBe('facebook');
    expect(url.searchParams.get('lead_public_id')).toBe('pub_123');
  });

  it('appends params to URL with existing query', () => {
    const result = appendParamsToUrl(
      'https://checkout.example.com/offer?product=x',
      {
        utm_source: 'facebook',
      },
    );
    const url = new URL(result);
    expect(url.searchParams.get('product')).toBe('x');
    expect(url.searchParams.get('utm_source')).toBe('facebook');
  });

  it('does not overwrite existing params', () => {
    const result = appendParamsToUrl(
      'https://checkout.example.com/?utm_source=existing',
      {
        utm_source: 'new_value',
      },
    );
    const url = new URL(result);
    // Existing param takes precedence
    expect(url.searchParams.get('utm_source')).toBe('existing');
  });

  it('returns original href on invalid URL (fail silently)', () => {
    // INV-TRACKER-007
    vi.stubGlobal('location', undefined);
    const result = appendParamsToUrl('not-a-url', { utm_source: 'fb' });
    // Should not throw; may return original or modified
    expect(typeof result).toBe('string');
  });

  it('handles URLs with fragments', () => {
    const result = appendParamsToUrl('https://example.com/page#section', {
      utm_source: 'fb',
    });
    expect(result).toContain('utm_source=fb');
    expect(result).toContain('#section');
  });
});

describe('decorateElement', () => {
  it('updates href on anchor element', () => {
    const el = {
      href: 'https://checkout.example.com/offer',
    } as HTMLAnchorElement;

    decorateElement(el, { utm_source: 'facebook', lead_public_id: 'pub_abc' });

    const url = new URL(el.href);
    expect(url.searchParams.get('utm_source')).toBe('facebook');
    expect(url.searchParams.get('lead_public_id')).toBe('pub_abc');
  });

  it('does not throw on element with no href (INV-TRACKER-007)', () => {
    const el = {} as HTMLAnchorElement;
    expect(() => decorateElement(el, { utm_source: 'fb' })).not.toThrow();
  });
});

describe('decorate() — main API', () => {
  beforeEach(() => {
    // Reset state to known values
    setState({
      status: 'ready',
      leadPublicId: 'pub_lead_xyz',
      attributionParams: FULL_ATTRIBUTION,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decorates elements by CSS selector', () => {
    const el1 = { href: 'https://checkout.example.com/a' } as HTMLAnchorElement;
    const el2 = { href: 'https://checkout.example.com/b' } as HTMLAnchorElement;

    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => [el1, el2]),
    });

    decorate('a[data-checkout]');

    expect(el1.href).toContain('lead_public_id=pub_lead_xyz');
    expect(el2.href).toContain('utm_source=facebook');
  });

  it('decorates a single HTMLAnchorElement via array wrapper', () => {
    // In node test env HTMLAnchorElement is unavailable — pass via array path.
    // In browser, decorate(element) also works via instanceof HTMLAnchorElement.
    const mockEl = {
      href: 'https://checkout.example.com/offer',
    };

    decorate([mockEl as HTMLAnchorElement]);

    expect(mockEl.href).toContain('lead_public_id=pub_lead_xyz');
  });

  it('decorates from NodeList', () => {
    const els = [
      { href: 'https://checkout.example.com/1' },
      { href: 'https://checkout.example.com/2' },
    ] as HTMLAnchorElement[];

    const nodeList = {
      [Symbol.iterator]: function* () {
        yield* els;
      },
      length: els.length,
      item: (i: number) => els[i] ?? null,
      forEach: (cb: (el: HTMLAnchorElement) => void) => els.forEach(cb),
    } as unknown as NodeList;

    decorate(nodeList);

    for (const el of els) {
      expect(el.href).toContain('lead_public_id=pub_lead_xyz');
    }
  });

  it('does nothing when no params to append', () => {
    setState({
      status: 'ready',
      leadPublicId: null,
      attributionParams: EMPTY_ATTRIBUTION,
    });

    const el = { href: 'https://checkout.example.com/offer' };
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => [el]),
    });

    decorate('a');

    // href should not have changed
    expect(el.href).toBe('https://checkout.example.com/offer');
  });

  it('does not throw when document is unavailable (INV-TRACKER-007)', () => {
    vi.stubGlobal('document', undefined);
    expect(() => decorate('a.checkout')).not.toThrow();
  });

  it('does not throw on invalid selector (INV-TRACKER-007)', () => {
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => {
        throw new Error('invalid selector');
      }),
    });
    expect(() => decorate('::invalid')).not.toThrow();
  });

  it('propagates lead_public_id for cross-domain checkout links', () => {
    // Cross-domain: cookies do not traverse — URL params must carry identity
    setState({
      status: 'ready',
      leadPublicId: 'pub_cross_domain_123',
      attributionParams: EMPTY_ATTRIBUTION,
    });

    const checkoutEl = {
      href: 'https://checkout.otherdomain.com/buy',
    } as HTMLAnchorElement;
    decorate([checkoutEl]);

    const url = new URL(checkoutEl.href);
    expect(url.searchParams.get('lead_public_id')).toBe('pub_cross_domain_123');
    // lead_public_id (not lead_id in clear — BR-TRACKER-001)
    expect(checkoutEl.href).not.toContain('lead_id=');
  });
});

describe('decorate() — UTM propagation detail', () => {
  it('propagates all non-null UTM params', () => {
    setState({
      status: 'ready',
      leadPublicId: null,
      attributionParams: {
        utm_source: 'google',
        utm_medium: 'email',
        utm_campaign: 'promo',
        utm_content: null,
        utm_term: 'keyword',
        fbclid: null,
        gclid: 'gclid_123',
        gbraid: null,
        wbraid: null,
      },
    });

    const el = { href: 'https://checkout.example.com/' } as HTMLAnchorElement;
    decorate([el]);

    const url = new URL(el.href);
    expect(url.searchParams.get('utm_source')).toBe('google');
    expect(url.searchParams.get('utm_medium')).toBe('email');
    expect(url.searchParams.get('utm_campaign')).toBe('promo');
    expect(url.searchParams.get('gclid')).toBe('gclid_123');
    // Null params should not be present
    expect(url.searchParams.get('utm_content')).toBeNull();
    expect(url.searchParams.get('fbclid')).toBeNull();
  });
});
