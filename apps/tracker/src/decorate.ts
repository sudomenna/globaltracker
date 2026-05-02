/**
 * Funil.decorate() — propagates attribution params + lead_public_id via URL params on links.
 *
 * Cross-domain context: cookies do not traverse domains, so attribution and identity
 * data must be propagated via URL query params when linking to checkout/other domains.
 * See: docs/20-domain/13-mod-tracker.md §10
 */

import { getState } from './state';
import type { AttributionParams } from './types';

/** Params appended by decorate() to checkout/external links. */
export interface DecorateParams {
  /** Lead public ID — safe to expose in URLs (not lead_id in clear — BR-TRACKER-001). */
  lead_public_id?: string;
  /** Attribution params serialized as individual query params. */
  attribution?: Partial<AttributionParams>;
}

/**
 * Build query params object for decoration.
 * Filters out null values to keep URLs clean.
 */
export function buildDecorateParams(
  leadPublicId: string | null,
  attribution: AttributionParams,
): Record<string, string> {
  const params: Record<string, string> = {};

  if (leadPublicId) {
    params.lead_public_id = leadPublicId;
  }

  // Append non-null attribution params
  const attrKeys: (keyof AttributionParams)[] = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'fbclid',
    'gclid',
    'gbraid',
    'wbraid',
  ];

  for (const key of attrKeys) {
    const val = attribution[key];
    if (val !== null && val !== undefined && val !== '') {
      params[key] = val;
    }
  }

  return params;
}

/**
 * Append query params to a URL string.
 * Preserves existing query params; does not overwrite existing keys.
 */
export function appendParamsToUrl(
  href: string,
  params: Record<string, string>,
): string {
  try {
    // Use URL constructor for safe parsing; fallback to string manipulation if relative URL
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      // Relative URL — construct using current origin as base
      if (typeof location !== 'undefined') {
        url = new URL(href, location.href);
      } else {
        return href;
      }
    }

    for (const [key, value] of Object.entries(params)) {
      // Do not overwrite existing params — respect what is already there
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  } catch {
    // INV-TRACKER-007: fail silently — return original href
    return href;
  }
}

/**
 * Decorate a single anchor element.
 */
export function decorateElement(
  el: HTMLAnchorElement,
  params: Record<string, string>,
): void {
  try {
    const newHref = appendParamsToUrl(el.href, params);
    el.href = newHref;
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Funil.decorate(selectorOrElement) — main public API.
 *
 * Accepts:
 *   - CSS selector string: selects all matching <a> elements
 *   - HTMLAnchorElement: decorates single element
 *   - NodeList or array of HTMLAnchorElement
 */
export function decorate(
  selectorOrElement:
    | string
    | HTMLAnchorElement
    | NodeList
    | HTMLAnchorElement[],
): void {
  try {
    const state = getState();
    const params = buildDecorateParams(
      state.leadPublicId,
      state.attributionParams,
    );

    if (Object.keys(params).length === 0) {
      // Nothing to append — skip
      return;
    }

    let elements: HTMLAnchorElement[] = [];

    if (typeof selectorOrElement === 'string') {
      if (typeof document === 'undefined') return;
      const nodeList =
        document.querySelectorAll<HTMLAnchorElement>(selectorOrElement);
      elements = Array.from(nodeList);
    } else if (Array.isArray(selectorOrElement)) {
      // Check array first — avoids relying on DOM globals in non-browser envs
      elements = selectorOrElement;
    } else if (
      typeof HTMLAnchorElement !== 'undefined' &&
      selectorOrElement instanceof HTMLAnchorElement
    ) {
      elements = [selectorOrElement];
    } else if (
      typeof NodeList !== 'undefined' &&
      selectorOrElement instanceof NodeList
    ) {
      elements = Array.from(selectorOrElement) as HTMLAnchorElement[];
    } else if (
      selectorOrElement != null &&
      typeof (selectorOrElement as { forEach?: unknown }).forEach === 'function'
    ) {
      // Duck-typed NodeList fallback (Symbol.iterator)
      for (const el of selectorOrElement as Iterable<HTMLAnchorElement>) {
        elements.push(el);
      }
    }

    for (const el of elements) {
      if (el?.href) {
        decorateElement(el, params);
      }
    }
  } catch {
    // INV-TRACKER-007: fail silently — tracker must not break the host page
  }
}
