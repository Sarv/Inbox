// Waking the read model after a write that went around the storage facade.
//
// Every sidebar badge is `folders.unread_count`, and that number is derived from
// the read-model projection, rebuilt whenever the dirty queue drains. A write to
// `emails` through the RAW handle (`storage.db`) still dirties the thread — the
// table triggers do that — but nothing schedules the drain, so the only thing
// that notices is the maintainer's 5-second safety pump. The row leaves the list
// immediately (the list is re-read on the spot) and the badge follows it one to
// five seconds later. Discarding a draft is where that gap is most visible.
//
// A function of its own, rather than the call repeated at each write, so the
// "never let it throw" rule lives in one place: this is bookkeeping about a
// write that has ALREADY succeeded, and a storage with no projection, or one
// mid-teardown, must not turn it into a failure.

import { createLogger } from '@sarvinbox/core';

const logger = createLogger('ReadModelPoke');

/** The slice of storage this needs. Optional because a storage without a read
 *  model has nothing to catch up. */
export interface ReadModelDrainable {
  scheduleReadModelDrain?: () => void;
}

/**
 * Ask `storage` to rebuild its read model now instead of on the next safety
 * pump. Call it after writing to the email tables through `storage.db`.
 */
export function pokeReadModel(storage: ReadModelDrainable | null | undefined): void {
  try {
    storage?.scheduleReadModelDrain?.();
  } catch (error) {
    logger.warn('Read-model catch-up request failed:', (error as Error)?.message ?? error);
  }
}
