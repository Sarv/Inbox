import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How far back the BACKGROUND AI pipeline may reach.
 *
 * THE incident: the window was a hardcoded 500 whose own comment claimed it
 * "mirrors the manual bulk cap (maxAIProcessingEmails, default 500)". It did
 * not — that setting lives in the renderer's localStorage and appeared nowhere
 * else in the main process. A user with 252 emails that passed EVERY other gate
 * (agent_status pending, unread, body downloaded, extraction done) raised the
 * setting to "All", and nothing happened: all 252 fell outside a window their
 * setting could not move, and the manual run they expected to start selected
 * zero rows because its own gate is `ai_processed_at IS NULL`, not the limit.
 */

const h = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  getThrows: false,
  setThrows: false,
  logs: [] as string[],
}));

vi.mock('../../../../electron/services/core-db', () => ({
  getBlob: (k: string) => {
    if (h.getThrows) throw new Error('core db closed');
    return h.blobs.get(k) ?? null;
  },
  setBlob: (k: string, v: Buffer) => {
    if (h.setThrows) throw new Error('disk full');
    h.blobs.set(k, v);
  },
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: (...a: unknown[]) => { h.logs.push(a.join(' ')); },
    warn: (...a: unknown[]) => { h.logs.push(a.join(' ')); },
    error: () => {}, debug: () => {},
  }),
}));

type Mod = typeof import('../../../../electron/services/ai-backlog-cap');
const load = async (): Promise<Mod> => {
  vi.resetModules();
  return import('../../../../electron/services/ai-backlog-cap');
};

beforeEach(() => { h.blobs.clear(); h.getThrows = false; h.setThrows = false; h.logs = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('normalizeBacklogCap', () => {
  // THE dangerous input. `getEmailsPendingAgent` treats recentWindow <= 0 as
  // "no window at all", so a zero falling through would silently switch the
  // background pipeline from "newest 500" to the ENTIRE mailbox, unattended —
  // an LLM bill, not a bug report.
  it('never lets a zero or negative disable the window', async () => {
    const { normalizeBacklogCap, DEFAULT_BACKLOG_CAP } = await load();
    expect(normalizeBacklogCap(0)).toBe(DEFAULT_BACKLOG_CAP);
    expect(normalizeBacklogCap(-1)).toBe(DEFAULT_BACKLOG_CAP);
  });

  it('falls back to the default for anything that is not a usable number', async () => {
    const { normalizeBacklogCap, DEFAULT_BACKLOG_CAP } = await load();
    for (const bad of [undefined, null, NaN, Infinity, 'lots', {}, []]) {
      expect(normalizeBacklogCap(bad)).toBe(DEFAULT_BACKLOG_CAP);
    }
  });

  // The window is an `ORDER BY date DESC LIMIT n` subquery evaluated every poll
  // tick; unbounded growth makes that a full scan on a large mailbox.
  it('caps absurd values rather than trusting them', async () => {
    const { normalizeBacklogCap, MAX_BACKLOG_CAP } = await load();
    expect(normalizeBacklogCap(10 ** 9)).toBe(MAX_BACKLOG_CAP);
  });

  it('accepts every value the settings UI actually offers', async () => {
    const { normalizeBacklogCap } = await load();
    for (const n of [100, 250, 500, 1000, 2500, 5000, 10000]) {
      expect(normalizeBacklogCap(n)).toBe(n);
    }
  });

  it('floors a fractional value instead of handing SQL a decimal LIMIT', async () => {
    const { normalizeBacklogCap } = await load();
    expect(normalizeBacklogCap(750.9)).toBe(750);
  });
});

describe('the persisted cap', () => {
  // The default has to match the renderer's defaultSettings, or a user who
  // never opened Settings gets a different window from one who did.
  it('starts at the default when nothing is stored', async () => {
    const { getAutoBacklogCap, DEFAULT_BACKLOG_CAP } = await load();
    expect(getAutoBacklogCap()).toBe(DEFAULT_BACKLOG_CAP);
  });

  // THE fix: raising the setting must actually move the background window.
  it('returns what the user set, and survives a main-process restart', async () => {
    const first = await load();
    expect(first.setAutoBacklogCap(10000)).toBe(10000);
    expect(first.getAutoBacklogCap()).toBe(10000);

    // Fresh module = a restarted main process reading the same storage.
    const restarted = await load();
    expect(restarted.getAutoBacklogCap()).toBe(10000);
  });

  it('normalizes on the way in, so bad input can never be persisted', async () => {
    const mod = await load();
    expect(mod.setAutoBacklogCap(0)).toBe(mod.DEFAULT_BACKLOG_CAP);
    expect((await load()).getAutoBacklogCap()).toBe(mod.DEFAULT_BACKLOG_CAP);
  });

  // An unreadable store must not take the pipeline down with it — a poll that
  // throws here stops categorizing everything, not just the backlog.
  it('falls back to the default when storage cannot be read', async () => {
    h.getThrows = true;
    const { getAutoBacklogCap, DEFAULT_BACKLOG_CAP } = await load();
    expect(getAutoBacklogCap()).toBe(DEFAULT_BACKLOG_CAP);
  });

  it('survives a corrupt stored value', async () => {
    h.blobs.set('ai-backlog-cap', Buffer.from('not json', 'utf8'));
    const { getAutoBacklogCap, DEFAULT_BACKLOG_CAP } = await load();
    expect(getAutoBacklogCap()).toBe(DEFAULT_BACKLOG_CAP);
  });

  // A failed WRITE must still change the running window: the user asked for it,
  // and refusing in-memory too would make the setting look broken twice.
  it('applies the new cap in memory even when it cannot be persisted', async () => {
    h.setThrows = true;
    const { setAutoBacklogCap, getAutoBacklogCap } = await load();
    expect(setAutoBacklogCap(2500)).toBe(2500);
    expect(getAutoBacklogCap()).toBe(2500);
  });

  // Re-pushing the same value on every settings write is normal; it must not
  // fill the log with one line per keystroke elsewhere in the settings blob.
  it('logs a change once, not on every identical re-push', async () => {
    const { setAutoBacklogCap } = await load();
    setAutoBacklogCap(1000);
    setAutoBacklogCap(1000);
    setAutoBacklogCap(1000);
    expect(h.logs.filter((l) => l.includes('background AI window'))).toHaveLength(1);
  });

  it('re-reads storage after the cache is reset', async () => {
    const mod = await load();
    mod.setAutoBacklogCap(5000);
    h.blobs.set('ai-backlog-cap', Buffer.from(JSON.stringify({ cap: 250 }), 'utf8'));
    mod.resetBacklogCapCache();
    expect(mod.getAutoBacklogCap()).toBe(250);
  });
});
