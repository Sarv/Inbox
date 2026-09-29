// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ipcCandidateSource,
  removeFirstSplitJob,
  startFirstSplitJob,
  type FirstSplitCandidates,
} from '../../../../../src/services/first-split/job';

/**
 * How the app wires the background first-email split to main's nominations
 * (App.tsx calls `startFirstSplitJob` on mount and `removeFirstSplitJob` on
 * unmount).
 *
 * What breaks if this file goes red: a second mount (React StrictMode, an HMR
 * reload) registers a second IPC listener and every background AI call is
 * made twice; unmount leaves the listener behind; or a renderer without the
 * bridge crashes on startup instead of simply running without the job.
 */

interface FakeAi {
  onFirstSplitCandidates: ReturnType<typeof vi.fn>;
  removeFirstSplitCandidatesListener: ReturnType<typeof vi.fn>;
  setBackgroundSplitEnabled: ReturnType<typeof vi.fn>;
  listeners: Array<(payload: FirstSplitCandidates) => void>;
}

const installBridge = (): FakeAi => {
  const ai: FakeAi = {
    listeners: [],
    setBackgroundSplitEnabled: vi.fn(async () => ({ success: true })),
    onFirstSplitCandidates: vi.fn((listener: (payload: FirstSplitCandidates) => void) => {
      ai.listeners.push(listener);
    }),
    removeFirstSplitCandidatesListener: vi.fn(() => {
      ai.listeners.length = 0;
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { ai };
  return ai;
};

beforeEach(() => {
  removeFirstSplitJob();
  // The job's own logger writes through console; keep the run quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  removeFirstSplitJob();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('startFirstSplitJob / removeFirstSplitJob (App wiring)', () => {
  // Duplicate listeners would double every background AI call.
  it('registers exactly one IPC listener however often it is started', () => {
    const ai = installBridge();
    startFirstSplitJob();
    startFirstSplitJob();
    expect(ai.onFirstSplitCandidates).toHaveBeenCalledTimes(1);
    expect(ai.listeners).toHaveLength(1);
  });

  // Unmount must clear the listener; a later mount (StrictMode's second run)
  // registers exactly one again.
  it('removal clears the listener, and a restart registers one again', () => {
    const ai = installBridge();
    startFirstSplitJob();
    removeFirstSplitJob();
    expect(ai.removeFirstSplitCandidatesListener).toHaveBeenCalledTimes(1);
    expect(ai.listeners).toHaveLength(0);
    removeFirstSplitJob();
    expect(ai.removeFirstSplitCandidatesListener).toHaveBeenCalledTimes(1);
    startFirstSplitJob();
    expect(ai.onFirstSplitCandidates).toHaveBeenCalledTimes(2);
    expect(ai.listeners).toHaveLength(1);
  });

  // Nominations arriving through the listener reach the job — which, with
  // background AI off (the default), drops them without any IPC.
  it('hands nominations to the job', () => {
    const ai = installBridge();
    startFirstSplitJob();
    expect(() => ai.listeners[0]!({ refs: [{ accountId: 'acct-a', threadId: 't1' }] })).not.toThrow();
  });

  // No bridge (a test harness, a preload without the channel): no job, no crash.
  it('is a no-op without the bridge', () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    expect(ipcCandidateSource()).toBeNull();
    expect(() => startFirstSplitJob()).not.toThrow();
    (window as unknown as { electronAPI: unknown }).electronAPI = { ai: {} };
    expect(ipcCandidateSource()).toBeNull();
  });
});

describe('startFirstSplitJob tells main whether the background split is on', () => {
  // Breaks: main's scheduler never learns the switch — at launch it stays off
  // and the background split never runs, or it scans every account every 45 s
  // while the reader has it switched off.
  it('pushes the switch at startup', () => {
    const ai = installBridge();
    startFirstSplitJob();
    expect(ai.setBackgroundSplitEnabled).toHaveBeenCalledWith(true);

    removeFirstSplitJob();
    localStorage.setItem('sarvinbox-ai-features', JSON.stringify([{ id: 'auto-chat-extract', enabled: false }]));
    startFirstSplitJob();
    expect(ai.setBackgroundSplitEnabled).toHaveBeenLastCalledWith(false);
  });

  // An older preload without the method, or a failing IPC: startup goes on.
  it('does not break startup when the push is missing or fails', async () => {
    const ai = installBridge();
    ai.setBackgroundSplitEnabled.mockRejectedValue(new Error('No handler registered'));
    expect(() => startFirstSplitJob()).not.toThrow();
    await Promise.resolve();
    removeFirstSplitJob();
    delete (ai as Partial<FakeAi>).setBackgroundSplitEnabled;
    expect(() => startFirstSplitJob()).not.toThrow();
    expect(ai.listeners).toHaveLength(1);
  });
});
