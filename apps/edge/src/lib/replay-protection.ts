/**
 * Replay protection helper — KV-backed deduplication for event_id per workspace.
 *
 * BR-EVENT-004: replay protection via KV cache TTL 7 days.
 * INV-EVENT-003: replay with same event_id within 7 days returns duplicate_accepted.
 *
 * Compatible with Cloudflare Workers KV (KVNamespace).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface — compatible with KVNamespace but also mockable in tests. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** KV key prefix to namespace replay protection entries. */
const REPLAY_KEY_PREFIX = 'replay:';

/**
 * Default TTL for replay protection records: 7 days.
 * BR-EVENT-004: TTL natural do KV = 7 dias.
 */
export const DEFAULT_REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildReplayKey(eventId: string, workspaceId: string): string {
  // BR-EVENT-004: key scoped to workspace to avoid cross-workspace key collision
  return `${REPLAY_KEY_PREFIX}${workspaceId}:${eventId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if an event has already been seen (replay detection).
 *
 * Returns true if the event_id has been seen within the TTL window (is a replay).
 * Returns false if it is a new event.
 *
 * BR-EVENT-004: KV replay protection TTL 7d.
 * INV-EVENT-003: single KV read — no write here; caller must call markSeen.
 */
export async function isReplay(
  eventId: string,
  workspaceId: string,
  kv: KvStore,
): Promise<boolean> {
  // BR-EVENT-004: KV replay protection — only 1 KV read per request (BR-EVENT-004 gherkin)
  const key = buildReplayKey(eventId, workspaceId);
  const existing = await kv.get(key);
  return existing !== null;
}

/**
 * Mark an event as seen in the replay protection KV store.
 *
 * Should be called after successfully accepting a new event.
 * Idempotent: calling multiple times for the same event_id is safe
 * (subsequent calls simply reset/extend the TTL).
 *
 * BR-EVENT-004: KV TTL = 7 days by default.
 *
 * **Best-effort**: KV write failures are caught and returned as `false` (caller
 * decides whether to log). Replay-protection é defesa em profundidade — o
 * idempotency check na inserção do `events` é a defesa primária. Lançar daqui
 * faria todo `/v1/events` virar 500 quando o KV bate o daily quota (consistente
 * com rate-limit / config-cache que também são best-effort).
 *
 * @param eventId - unique event identifier
 * @param workspaceId - workspace scope
 * @param kv - KV store
 * @param ttlSeconds - optional override (default 604800 = 7 days)
 * @returns `true` se gravado; `false` se write falhou (KV quota/erro transiente)
 */
export async function markSeen(
  eventId: string,
  workspaceId: string,
  kv: KvStore,
  ttlSeconds: number = DEFAULT_REPLAY_TTL_SECONDS,
): Promise<boolean> {
  // BR-EVENT-004: set KV entry with TTL so it auto-expires after the window
  const key = buildReplayKey(eventId, workspaceId);
  try {
    await kv.put(key, '1', { expirationTtl: ttlSeconds });
    return true;
  } catch {
    return false;
  }
}
