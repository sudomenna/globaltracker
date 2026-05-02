/**
 * sanitize-logs.ts — Hono middleware for PII-safe structured logging.
 *
 * Intercepts every request/response cycle and emits a structured log entry
 * containing ONLY non-PII fields. Additionally exports a `sanitize()` helper
 * that can be used anywhere in the codebase to scrub arbitrary objects before
 * logging.
 *
 * BR-PRIVACY-001: PII in plain is prohibited in logs, error responses, or jsonb.
 *   Redacted fields: email, phone, name, ip (plain), user_agent (plain),
 *   plus any value matching email-regex or CPF-regex.
 *
 * Safe fields logged: workspace_id, page_id, event_type, status_code,
 *   request_id, method, path (without query PII), duration_ms, timestamps.
 *
 * The middleware does NOT modify request/response bodies — it only controls
 * what is written to console. Route handlers are responsible for not logging
 * PII themselves.
 */

import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

// ---------------------------------------------------------------------------
// PII redaction rules
// ---------------------------------------------------------------------------

/** Field names (case-insensitive) that must always be redacted. */
const REDACT_FIELD_NAMES = new Set([
  'email',
  'phone',
  'name',
  'ip',
  'user_agent',
  'useragent',
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'credit_card',
  'creditcard',
  'cvv',
  'ssn',
  'cpf',
  'cnpj',
]);

/** Regex patterns for detecting PII values regardless of field name. */
const PII_VALUE_PATTERNS: RegExp[] = [
  // Email address
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  // Brazilian CPF (digits with optional dots/dash)
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
  // Simple phone pattern (7+ digits, optional country code)
  /^\+?[\d\s\-().]{7,20}$/,
];

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Sanitize helper (exported for use in route handlers and lib)
// ---------------------------------------------------------------------------

/**
 * Recursively sanitize an object by:
 *   1. Replacing known PII field names with [REDACTED].
 *   2. Replacing string values that match PII patterns with [REDACTED].
 *
 * BR-PRIVACY-001: zero PII in log output.
 *
 * @param input - any value (object, array, primitive)
 * @param depth - internal recursion guard (default 0; max 10)
 * @returns sanitized clone of input
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- sanitize must handle arbitrary input
export function sanitize(input: unknown, depth = 0): unknown {
  if (depth > 10) return '[DEPTH_LIMIT]';

  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    // BR-PRIVACY-001: check if string value itself looks like PII
    for (const pattern of PII_VALUE_PATTERNS) {
      if (pattern.test(input)) return REDACTED;
    }
    return input;
  }

  if (typeof input === 'number' || typeof input === 'boolean') return input;

  if (Array.isArray(input)) {
    return input.map((item) => sanitize(item, depth + 1));
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (REDACT_FIELD_NAMES.has(k.toLowerCase())) {
        result[k] = REDACTED;
      } else {
        result[k] = sanitize(v, depth + 1);
      }
    }
    return result;
  }

  return input;
}

// ---------------------------------------------------------------------------
// Safe console wrapper
// ---------------------------------------------------------------------------

/**
 * Emit a structured log entry with only safe fields.
 * Automatically sanitizes any `data` payload before logging.
 *
 * BR-PRIVACY-001: only workspace_id, page_id, event_type, status_code,
 *   request_id, timestamps allowed in output.
 */
export function safeLog(
  level: 'info' | 'warn' | 'error',
  entry: {
    event: string;
    request_id?: string;
    workspace_id?: string;
    page_id?: string;
    event_type?: string;
    status_code?: number;
    method?: string;
    path?: string;
    duration_ms?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- allow arbitrary extra context
    [key: string]: unknown;
  },
): void {
  // Sanitize the entire entry before logging
  const sanitized = sanitize({ ...entry, level, ts: new Date().toISOString() });
  const line = JSON.stringify(sanitized);

  switch (level) {
    case 'error':
      console.error(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Sanitize-logs middleware — logs every request/response with safe fields only.
 *
 * Attach early in the middleware chain (before auth) so all requests are logged.
 *
 * Usage:
 * ```ts
 * app.use('*', sanitizeLogs());
 * ```
 */
export function sanitizeLogs(): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const startMs = Date.now();

    // Ensure request_id is set; generate if missing
    const existingId: string | undefined = c.get('request_id') as
      | string
      | undefined;
    const requestId = existingId ?? crypto.randomUUID();
    if (!existingId) {
      c.set('request_id', requestId);
    }

    // Attach request_id to response before anything else
    c.res.headers.set('X-Request-Id', requestId);

    // Strip query string from path for logging — query may contain PII tokens
    const rawPath = new URL(c.req.url).pathname;

    safeLog('info', {
      event: 'request_start',
      request_id: requestId,
      method: c.req.method,
      path: rawPath,
    });

    await next();

    const durationMs = Date.now() - startMs;
    const statusCode = c.res.status;

    // workspace_id and page_id may be set by auth middleware
    const workspaceId: string | undefined = c.get('workspace_id') as
      | string
      | undefined;
    const pageId: string | undefined = c.get('page_id') as string | undefined;

    safeLog(statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info', {
      event: 'request_end',
      request_id: requestId,
      method: c.req.method,
      path: rawPath,
      status_code: statusCode,
      duration_ms: durationMs,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(pageId ? { page_id: pageId } : {}),
    });

    // Ensure X-Request-Id is present on the final response
    c.res.headers.set('X-Request-Id', requestId);
  });
}
