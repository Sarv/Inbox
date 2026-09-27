import { describe, expect, it, vi } from 'vitest';

import { pokeReadModel } from '../../../../electron/services/read-model-poke';

// What breaks if this file fails: every sidebar badge is counted from the
// read-model projection, and a write made on the raw database handle schedules
// nothing — the number then settles on the maintainer's 5-second safety pump.
// That is the 1-5s a discarded draft's row was gone from the list while the
// Drafts badge still showed the old count. The other half of the contract is
// that asking must never be able to fail the write that already happened.
describe('pokeReadModel', () => {
  // Breaks: THE regression — the badge waits for the safety pump.
  it('asks a storage that has a read model to catch up now', () => {
    const scheduleReadModelDrain = vi.fn();

    pokeReadModel({ scheduleReadModelDrain });

    expect(scheduleReadModelDrain).toHaveBeenCalledTimes(1);
  });

  // Breaks: a storage built before the projection existed (or a test double)
  // throws a TypeError out of a delete that had already succeeded.
  it('does nothing when the storage has no read model', () => {
    expect(() => pokeReadModel({})).not.toThrow();
  });

  // Breaks: a write during teardown, when the runtime is already unregistered,
  // reports as a failed delete to the caller.
  it('does nothing when there is no storage at all', () => {
    expect(() => pokeReadModel(null)).not.toThrow();
    expect(() => pokeReadModel(undefined)).not.toThrow();
  });

  // Breaks: the store is closing and its scheduler throws — bookkeeping about a
  // committed write must not turn that write into an error for the user.
  it('swallows a throwing scheduler', () => {
    const scheduleReadModelDrain = vi.fn(() => { throw new Error('closed'); });

    expect(() => pokeReadModel({ scheduleReadModelDrain })).not.toThrow();
    expect(scheduleReadModelDrain).toHaveBeenCalledTimes(1);
  });
});
