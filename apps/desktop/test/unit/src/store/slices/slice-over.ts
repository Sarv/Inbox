import type { SliceCreator } from '../../../../../src/store/types';

/**
 * Build one store slice over a hand-rolled `set` / `get`, for a harness that
 * drives a single slice without a zustand store.
 *
 * Only `set` and `get` are passed. zustand calls every StateCreator with a
 * third argument, the store api, but the slices built this way never read it
 * and a harness has no real one to give. The stand-ins these harnesses used to
 * pass (`undefined as any`, `{} as any`) only looked like a store. A slice that
 * starts to need the api still fails loudly here, exactly as it did with them,
 * and that harness should then build a real store with `createStore` instead.
 *
 * A harness that composes several slices into a real store spreads the
 * creator's arguments instead, `createStore((...a) => ({ ...createXSlice(...a) }))`,
 * the way `email-store.ts` does.
 */
export function sliceOver<T>(creator: SliceCreator<T>, set: unknown, get: unknown): T {
  return (creator as unknown as (set: unknown, get: unknown) => T)(set, get);
}
