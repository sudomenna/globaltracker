/**
 * Meta Custom Audiences batcher.
 *
 * Splits a large member list into batches of at most META_BATCH_SIZE items,
 * respecting the Meta Marketing API limit of 10,000 members per request.
 *
 * T-5-005
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of members per Meta Custom Audiences API request. */
export const META_BATCH_SIZE = 10_000;

// ---------------------------------------------------------------------------
// batchMembers
// ---------------------------------------------------------------------------

/**
 * Generator that yields slices of `members` up to `size` items each.
 *
 * @param members - full list of items to batch.
 * @param size    - maximum batch size (default META_BATCH_SIZE = 10 000).
 */
export function* batchMembers<T>(
  members: T[],
  size: number = META_BATCH_SIZE,
): Generator<T[]> {
  for (let i = 0; i < members.length; i += size) {
    yield members.slice(i, i + size);
  }
}
