/**
 * A byte budget for one chunk of a background pass over email bodies.
 *
 * ## Why a byte budget and not a row count
 *
 * Every background pass in this app walks rows whose cost varies by four orders
 * of magnitude: the smallest body is ~200 bytes, the largest measured `raw_body`
 * is 21 MB. A row-counted chunk (`LIMIT 50`) therefore bounds nothing — the same
 * 50 rows are 10 KB of notifications or 900 MB of newsletters, and the second
 * case holds the transaction, the WAL and the main thread for as long as it
 * takes.
 *
 * This is the same mistake as `if (i % 500 === 0) await yield()`, one level up.
 * Yielding on a time budget between chunks (see `createLoopYielder`) bounds the
 * GAP between chunks; it cannot bound a chunk, because a chunk is a single
 * transaction that runs to completion. Both have to be budgeted, and each has to
 * be budgeted on the thing that actually varies.
 *
 * Measured on the live mailbox: the body-relocation pass moved 26,198 rows in
 * 193 s at 50 rows per chunk — ~18 MB per transaction, and the event-loop
 * monitor logged the resulting 851 ms freezes.
 *
 * ## Always at least one item
 *
 * The first item is admitted whatever its size. A 21 MB body cannot fit any
 * sensible budget, and refusing it would park it at the head of the cursor
 * forever and stall every row behind it. Better one long chunk, once, than a
 * pass that never finishes.
 */

/** A chunk's remaining room, in bytes. See {@link createByteBudget}. */
export interface ByteBudget {
  /**
   * Is there room for an item of this size? True for the first item regardless.
   *
   * For callers that know an item's size BEFORE doing its work (a `LENGTH()`
   * column in the selecting query).
   */
  admits(bytes: number): boolean;
  /** Account for an item that was taken. */
  spend(bytes: number): void;
  /**
   * Has the budget been reached?
   *
   * For callers that only learn an item's size by doing its work (a `RETURNING`
   * clause on the write): do the row, `spend`, then stop if this is true. That
   * order is what guarantees the at-least-one-item rule for those callers.
   */
  isExhausted(): boolean;
  /** Bytes accounted for so far. */
  readonly spent: number;
  /** Items accounted for so far. */
  readonly items: number;
}

/** A byte budget of `limitBytes`, spent by the chunk that owns it. */
export function createByteBudget(limitBytes: number): ByteBudget {
  let spent = 0;
  let items = 0;
  return {
    admits: (bytes: number): boolean => items === 0 || spent + bytes <= limitBytes,
    spend: (bytes: number): void => {
      // Guard the accumulator, not the caller: a NULL LENGTH() from SQLite
      // arrives as null, and `spent + null` would silently become 0 and make the
      // budget infinite — every row would then be admitted, which is the bug
      // this module exists to prevent.
      spent += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
      items += 1;
    },
    isExhausted: (): boolean => spent >= limitBytes,
    get spent(): number {
      return spent;
    },
    get items(): number {
      return items;
    },
  };
}
