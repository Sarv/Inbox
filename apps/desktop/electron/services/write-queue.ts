import pLimit from 'p-limit';

/**
 * Serialize-writes mutex. Enqueued operations run one at a time so concurrent
 * writes can't interleave. Backed by `p-limit(1)` (the standard concurrency
 * limiter) rather than a hand-rolled promise chain; a rejected op does not wedge
 * the queue — the next enqueued op still runs.
 */
export interface WriteQueue {
  enqueue: (fn: () => Promise<void>) => Promise<void>;
}

export const createWriteQueue = (): WriteQueue => {
  const limit = pLimit(1);
  return { enqueue: (fn) => limit(fn) };
};
