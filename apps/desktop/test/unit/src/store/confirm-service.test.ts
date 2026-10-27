import { describe, it, expect, beforeEach } from 'vitest';

import { requestConfirm, useConfirmStore } from '../../../../src/store/confirm-service';

// App-wide promise-based confirm, used from NON-React code (store slices like
// bulkRemoveEmails). The contract that matters: the promise resolves with the
// user's answer exactly once, and the dialog state clears afterwards — a leaked
// `current` would leave the modal stuck on screen over the mail list.
describe('confirm-service', () => {
  beforeEach(() => {
    useConfirmStore.setState({ current: null });
  });

  it('starts with no pending confirmation', () => {
    expect(useConfirmStore.getState().current).toBeNull();
  });

  it('stages the options for the mounted dialog and keeps the promise pending', async () => {
    const promise = useConfirmStore.getState().request({ title: 'Delete 3 emails?', message: 'This cannot be undone.', confirmLabel: 'Delete' });
    expect(useConfirmStore.getState().current).toMatchObject({ title: 'Delete 3 emails?', message: 'This cannot be undone.', confirmLabel: 'Delete' });

    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting on the user

    useConfirmStore.getState().resolve(true);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when the user cancels, and clears the dialog either way', async () => {
    const promise = useConfirmStore.getState().request({ title: 'Move to Trash?', message: 'Move 3 emails to Trash?' });
    useConfirmStore.getState().resolve(false);
    await expect(promise).resolves.toBe(false);
    expect(useConfirmStore.getState().current).toBeNull();
  });

  it('is a safe no-op when resolve fires with nothing pending', () => {
    // The global dialog can unmount/re-fire; this must not throw during teardown.
    expect(() => useConfirmStore.getState().resolve(true)).not.toThrow();
    expect(useConfirmStore.getState().current).toBeNull();
  });

  it('cancels a replaced request without granting permission to its operation', async () => {
    const first = useConfirmStore.getState().request({ title: 'First', message: 'first' });
    const second = useConfirmStore.getState().request({ title: 'Second', message: 'second' });
    expect(useConfirmStore.getState().current?.title).toBe('Second');
    await expect(first).resolves.toBe(false);
    expect(useConfirmStore.getState().current?.title).toBe('Second');

    useConfirmStore.getState().resolve(true);
    await expect(second).resolves.toBe(true);
    expect(useConfirmStore.getState().current).toBeNull();
    await expect(first).resolves.toBe(false);
  });

  it('keeps only the latest prompt pending across repeated replacements', async () => {
    const first = requestConfirm({ title: 'First', message: 'first' });
    const second = requestConfirm({ title: 'Second', message: 'second' });
    const third = requestConfirm({ title: 'Third', message: 'third' });
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(useConfirmStore.getState().current?.title).toBe('Third');
    useConfirmStore.getState().resolve(false);
    await expect(third).resolves.toBe(false);
    expect(useConfirmStore.getState().current).toBeNull();
  });

  it('requestConfirm is the imperative entry point onto the same store', async () => {
    const promise = requestConfirm({ title: 'From a store slice', message: 'triggered outside React' });
    expect(useConfirmStore.getState().current?.title).toBe('From a store slice');
    useConfirmStore.getState().resolve(true);
    await expect(promise).resolves.toBe(true);
  });
});
