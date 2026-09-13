// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

import { createProgressHub } from '../../../../src/services/progress-hub';

// The hub is what lets a caller who JOINS an already-running job still see it
// progress. Break any of these and the symptom is the one this file was written
// for: a spinner that never turns into content because the only party holding
// the progress callbacks isn't the party running the job.

describe('createProgressHub', () => {
  it('broadcasts each update to every subscriber', () => {
    // If fan-out drops a listener, one of two views watching the same
    // extraction silently freezes while the other updates.
    const hub = createProgressHub<number>();
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(first);
    hub.subscribe(second);

    hub.publish(1);
    hub.publish(2);

    expect(first.mock.calls.map(c => c[0])).toEqual([1, 2]);
    expect(second.mock.calls.map(c => c[0])).toEqual([1, 2]);
  });

  it('replays the latest snapshot to a subscriber that arrives late', () => {
    // THE bug: the user opens a thread the background extractor started
    // minutes ago. Without replay they wait for the NEXT update — on a big
    // thread that is a whole LLM round-trip away, and the pane stays empty.
    const hub = createProgressHub<string>();
    hub.publish('three of nine');
    const late = vi.fn();

    hub.subscribe(late);

    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith('three of nine');
    expect(hub.last).toBe('three of nine');
  });

  it('replays nothing when the run has not published yet', () => {
    // A subscriber attaching before the first update must not be handed a
    // fabricated "empty" snapshot — that would clear the spinner too early.
    const hub = createProgressHub<string>();
    const early = vi.fn();

    hub.subscribe(early);

    expect(early).not.toHaveBeenCalled();
    expect(hub.last).toBeNull();
  });

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', () => {
    // The UI unsubscribes when its join resolves; a leaked listener would keep
    // a closed thread's setState alive and repaint a view the user left.
    const hub = createProgressHub<number>();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);

    hub.publish(1);
    unsubscribe();
    unsubscribe();
    hub.publish(2);

    expect(listener.mock.calls.map(c => c[0])).toEqual([1]);
  });

  it('keeps publishing when a subscriber throws', () => {
    // A watcher's failure (setState on an unmounted tree) must never abort the
    // extraction or rob the other watchers — the job outlives its audience.
    const hub = createProgressHub<number>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exploding = vi.fn(() => { throw new Error('render failed'); });
    const healthy = vi.fn();
    hub.subscribe(exploding);
    hub.subscribe(healthy);

    expect(() => hub.publish(7)).not.toThrow();

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledWith(7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lets a listener unsubscribe from inside its own callback', () => {
    // A one-shot watcher ("paint the first bubble then detach") would otherwise
    // mutate the listener set mid-broadcast and skip the next subscriber.
    const hub = createProgressHub<number>();
    const seen: number[] = [];
    const after = vi.fn();
    const off = hub.subscribe((n) => { seen.push(n); off(); });
    hub.subscribe(after);

    hub.publish(1);
    hub.publish(2);

    expect(seen).toEqual([1]);
    expect(after.mock.calls.map(c => c[0])).toEqual([1, 2]);
  });
});
