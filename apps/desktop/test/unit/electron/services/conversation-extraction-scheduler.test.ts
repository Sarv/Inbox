import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first-split nomination scheduler (main). It hands the renderer threads
 * whose first email may need an AI split — per ACCOUNT, each ref naming its
 * account — only while an AI provider is configured and a window exists,
 * starts 10 s after boot, then runs every 45 s, and stop() must cancel the
 * pending FIRST tick too (otherwise it fires after storage close on a fast
 * quit).
 *
 * What breaks if this file goes red: the background pre-split only ever sees
 * the ACTIVE account (the scheduler it replaced read `getStorage()`), a ref
 * without its account lands in another account's cache, one broken account
 * database stops every other account's nominations, ordinary mail with no
 * reply/forward evidence is sent to the AI job, a thread the renderer cannot
 * decide yet starves every thread behind it, the newest non-replies fill every
 * scan slot for ever so an older looped-in forward is never reached, or the
 * scan runs (and cools refs down) while the background split is switched off.
 */

const INITIAL_DELAY_MS = 10_000;
const INTERVAL_MS = 45_000;
const CHANNEL = 'conversation:first-split-candidates';

interface Candidate {
  threadId: string;
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  lastMessageDate: number;
  reason: string;
}

interface FakeAccount {
  calls: Array<Record<string, unknown>>;
  candidates: Candidate[];
  throws: boolean;
  /** skipFirstSplits throws (a locked database). */
  skipThrows: boolean;
  /** Every skipFirstSplits call's thread ids. */
  skipped: string[][];
}

/** The repository's cap on examined threads per candidate slot (FIRST_SPLIT_SCAN_ROWS_PER_SLOT). */
const ROWS_PER_SLOT = 10;

const h = vi.hoisted(() => ({
  accounts: new Map<string, unknown>(),
  window: null as { sent: Array<{ channel: string; payload: { refs: Array<{ accountId: string; threadId: string }> } }> } | null,
}));

vi.mock('../../../../electron/shared', () => ({
  getAllAccountRuntimes: () => [...h.accounts.entries()].map(([id, account]) => [id, { storage: account }]),
  getMainWindow: () =>
    h.window
      ? { webContents: { send: (channel: string, payload: unknown) => h.window!.sent.push({ channel, payload: payload as never }) } }
      : null,
}));

vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

type Scheduler = typeof import('../../../../electron/services/conversation-extraction-scheduler');

/** Fresh module — the "AI configured" flag and the cool-downs are module state. */
const load = async (): Promise<Scheduler> => {
  vi.resetModules();
  return import('../../../../electron/services/conversation-extraction-scheduler');
};

const reply = (threadId: string, over: Partial<Candidate> = {}): Candidate => ({
  threadId,
  subject: 'Re: budget',
  inReplyTo: '<parent@x>',
  references: null,
  lastMessageDate: 1_000,
  reason: 'no-row',
  ...over,
});

/**
 * An account whose storage answers the candidate scan (and records it). It
 * models the repository's contract (storage-node's first-split tests pin the
 * real one): newest first, at most scanLimit x ROWS_PER_SLOT threads
 * examined, only those `accept` takes returned and counted against
 * scanLimit — and a retired thread (skipFirstSplits) leaves the set.
 */
const addAccount = (accountId: string, candidates: Candidate[], over: Partial<FakeAccount> = {}) => {
  const account: FakeAccount = { calls: [], candidates, throws: false, skipThrows: false, skipped: [], ...over };
  h.accounts.set(accountId, {
    listFirstSplitCandidates: (options: { scanLimit: number; accept?: (c: Candidate) => boolean }) => {
      account.calls.push(options as unknown as Record<string, unknown>);
      if (account.throws) throw new Error('database is locked');
      const out: Candidate[] = [];
      for (const candidate of account.candidates.slice(0, options.scanLimit * ROWS_PER_SLOT)) {
        if (out.length >= options.scanLimit) break;
        if (options.accept && !options.accept(candidate)) continue;
        out.push(candidate);
      }
      return out;
    },
    skipFirstSplits: (threadIds: string[]) => {
      if (account.skipThrows) throw new Error('database is locked');
      account.skipped.push([...threadIds]);
      const retired = new Set(threadIds);
      account.candidates = account.candidates.filter((candidate) => !retired.has(candidate.threadId));
      return threadIds.length;
    },
  });
  return account;
};

/** Both switches the renderer reports: a provider, and the background split on. */
const enable = (svc: Scheduler) => {
  svc.setAIProviderConfigured(true);
  svc.setBackgroundSplitEnabled(true);
};

const plain = (threadId: string, over: Partial<Candidate> = {}): Candidate =>
  reply(threadId, { subject: `Newsletter ${threadId}`, inReplyTo: null, references: null, ...over });

const sent = () => h.window!.sent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
  h.accounts.clear();
  h.window = { sent: [] };
});

afterEach(() => { vi.useRealTimers(); });

describe('the AI-provider gate', () => {
  // Regression: a provider removed mid-session (API key deleted) kept the scan
  // nominating refs the renderer can no longer split, every 45 s per account.
  it('stops scanning and sending once the renderer reports the provider gone', async () => {
    const account = addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    enable(svc);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(sent()).toHaveLength(1);
    const scans = account.calls.length;

    svc.setAIProviderConfigured(false);
    await vi.advanceTimersByTimeAsync(svc.NOMINATION_COOLDOWN_MS + 3 * INTERVAL_MS);
    expect(account.calls).toHaveLength(scans);
    expect(sent()).toHaveLength(1);
    svc.stopConversationScheduler();
  });

  // No provider: the renderer could not split anything, so not even the scan runs.
  it('does nothing at all while no AI provider is configured', async () => {
    const account = addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * INTERVAL_MS);
    expect(account.calls).toEqual([]);
    expect(sent()).toEqual([]);
    svc.stopConversationScheduler();
  });

  // No window: nobody to hand the refs to — no scan either.
  it('does nothing without a window', async () => {
    const account = addAccount('acct-a', [reply('t1')]);
    h.window = null;
    const svc = await load();
    enable(svc);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(account.calls).toEqual([]);
    svc.stopConversationScheduler();
  });
});

describe('pacing', () => {
  it('first tick after 10s, then every 45s', async () => {
    const account = addAccount('acct-a', []);
    const svc = await load();
    enable(svc);

    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(account.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(account.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(account.calls).toHaveLength(2);
    svc.stopConversationScheduler();
  });

  it('is idempotent', async () => {
    const account = addAccount('acct-a', []);
    const svc = await load();
    enable(svc);
    svc.startConversationScheduler();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(account.calls).toHaveLength(1);
    svc.stopConversationScheduler();
  });

  it('stop() cancels the pending FIRST tick (fast quit)', async () => {
    const account = addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    enable(svc);
    svc.startConversationScheduler();
    svc.stopConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 5 * INTERVAL_MS);
    expect(account.calls).toEqual([]);
  });

  it('stop() after the first tick cancels the interval', async () => {
    const account = addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    enable(svc);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    svc.stopConversationScheduler();
    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(account.calls).toHaveLength(1);
  });

  it('is safe to stop when never started, and can be restarted', async () => {
    const account = addAccount('acct-a', []);
    const svc = await load();
    enable(svc);
    expect(() => svc.stopConversationScheduler()).not.toThrow();
    svc.startConversationScheduler();
    svc.stopConversationScheduler();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(account.calls).toHaveLength(1);
    svc.stopConversationScheduler();
  });
});

describe('nominations', () => {
  const tick = async (svc: Scheduler) => {
    enable(svc);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
  };

  // Regression: the old scheduler read only the ACTIVE account's database, so
  // looped-in mail in every other account never got a background split. One
  // message per account, each ref naming its account.
  it('sends one message per account, every ref carrying its account id', async () => {
    addAccount('acct-a', [reply('t1')]);
    addAccount('acct-b', [reply('t1'), reply('t2')]);
    const svc = await load();
    await tick(svc);
    expect(sent()).toEqual([
      { channel: CHANNEL, payload: { refs: [{ accountId: 'acct-a', threadId: 't1' }] } },
      {
        channel: CHANNEL,
        payload: { refs: [{ accountId: 'acct-b', threadId: 't1' }, { accountId: 'acct-b', threadId: 't2' }] },
      },
    ]);
    svc.stopConversationScheduler();
  });

  // The scan is asked for the current split version, the 30-day window, the
  // retry cap and the time — the SQL pre-selection depends on each.
  it('scans the last 30 days for the current split version', async () => {
    const account = addAccount('acct-a', []);
    const svc = await load();
    await tick(svc);
    const now = Math.floor(Date.now() / 1000);
    expect(account.calls[0]).toEqual({
      since: now - svc.CANDIDATE_WINDOW_SECONDS,
      scanLimit: svc.CANDIDATE_SCAN_LIMIT,
      version: 1,
      now,
      maxAttempts: 5,
      accept: expect.any(Function),
    });
    svc.stopConversationScheduler();
  });

  // Only a reply or a forward can carry a looped-in history: In-Reply-To,
  // References, or a reply/forward subject prefix in any language the core
  // normaliser knows ('Fwd:', 'AW:'). A fresh mail is never nominated.
  it('sends only threads with reply or forward evidence', async () => {
    const account = addAccount('acct-a', [
      reply('in-reply-to', { subject: 'budget', inReplyTo: '<p@x>' }),
      reply('references', { subject: 'budget', inReplyTo: null, references: '<a@x> <b@x>' }),
      reply('fwd', { subject: 'Fwd: budget', inReplyTo: null }),
      reply('aw', { subject: 'AW: Angebot', inReplyTo: null }),
      reply('fresh', { subject: 'budget', inReplyTo: null, references: null }),
      reply('blank', { subject: '', inReplyTo: '  ', references: '' }),
    ]);
    const svc = await load();
    await tick(svc);
    expect(sent()[0].payload.refs.map((ref: { threadId: string }) => ref.threadId))
      .toEqual(['in-reply-to', 'references', 'fwd', 'aw']);
    // …and the rest are retired, never nominated.
    expect(account.skipped).toEqual([['fresh', 'blank']]);
    svc.stopConversationScheduler();
  });

  // The renderer splits one thread at a time; a pass never floods it.
  it('sends at most 5 refs per account, newest first as scanned', async () => {
    addAccount('acct-a', Array.from({ length: 12 }, (_, i) => reply(`t${i}`)));
    const svc = await load();
    await tick(svc);
    expect(sent()[0].payload.refs.map((ref: { threadId: string }) => ref.threadId))
      .toEqual(['t0', 't1', 't2', 't3', 't4']);
    svc.stopConversationScheduler();
  });

  it('stays silent for an account with nothing to nominate', async () => {
    const account = addAccount('acct-a', [reply('fresh', { subject: 'hello', inReplyTo: null })]);
    const svc = await load();
    await tick(svc);
    expect(sent()).toEqual([]);
    expect(account.skipped).toEqual([['fresh']]);
    svc.stopConversationScheduler();
  });

  // Multi-account failure isolation: a locked / closed database is a warning
  // for that account, never a stop for the others.
  it('keeps nominating the other accounts when one account throws', async () => {
    addAccount('acct-a', [], { throws: true });
    addAccount('acct-b', [reply('t9')]);
    const svc = await load();
    await tick(svc);
    expect(sent()).toEqual([
      { channel: CHANNEL, payload: { refs: [{ accountId: 'acct-b', threadId: 't9' }] } },
    ]);
    svc.stopConversationScheduler();
  });

  // Whatever a broken database throws — not always an Error — is a warning.
  it('survives an account that throws a non-Error', async () => {
    h.accounts.set('acct-a', { listFirstSplitCandidates: () => { throw 'SQLITE_BUSY'; } });
    addAccount('acct-b', [reply('t2')]);
    const svc = await load();
    await tick(svc);
    expect(sent().map((each) => each.payload.refs[0]!.accountId)).toEqual(['acct-b']);
    svc.stopConversationScheduler();
  });

  // A transient failure is retried: the account that threw is scanned again
  // on the next pass, and nominates once it answers.
  it('scans a failing account again on the next pass', async () => {
    const account = addAccount('acct-a', [reply('t1')], { throws: true });
    const svc = await load();
    await tick(svc);
    expect(sent()).toEqual([]);
    account.throws = false;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toEqual([{ channel: CHANNEL, payload: { refs: [{ accountId: 'acct-a', threadId: 't1' }] } }]);
    svc.stopConversationScheduler();
  });

  // Starvation guard: a thread the renderer cannot decide yet (no body) stays
  // a candidate. Re-sending the same newest five every 45 s would starve every
  // older thread, so a nominated thread waits out the cool-down and the next
  // pass reaches further down the list.
  it('does not re-send a nominated thread until its cool-down has passed', async () => {
    addAccount('acct-a', Array.from({ length: 7 }, (_, i) => reply(`t${i}`)));
    const svc = await load();
    await tick(svc);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    const ids = (index: number) => sent()[index].payload.refs.map((ref: { threadId: string }) => ref.threadId);
    expect(ids(0)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(ids(1)).toEqual(['t5', 't6']);
    // Everything is cooling down: the next passes send nothing…
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toHaveLength(2);
    // …until the cool-down runs out, when the undecided threads come back.
    await vi.advanceTimersByTimeAsync(svc.NOMINATION_COOLDOWN_MS);
    expect(sent().length).toBeGreaterThan(2);
    expect(ids(2)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    svc.stopConversationScheduler();
  });

  // The cool-down is per ACCOUNT: the same thread id in another account's
  // database is a different thread and is nominated on its own.
  it('cools down per account, not per thread id', async () => {
    addAccount('acct-a', [reply('t1')]);
    addAccount('acct-b', [reply('t1')]);
    const svc = await load();
    await tick(svc);
    expect(sent().map((each) => each.payload.refs[0].accountId)).toEqual(['acct-a', 'acct-b']);
    svc.stopConversationScheduler();
  });

  // A restart (account switch, re-login) starts from a clean slate.
  it('forgets cool-downs on stop', async () => {
    addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    await tick(svc);
    svc.stopConversationScheduler();
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(sent()).toHaveLength(2);
    svc.stopConversationScheduler();
  });
});

describe('the background-split switch', () => {
  // Conversation mode or 'Auto Chat Extract' off: the renderer drops every ref
  // whole, so a scan is wasted main-thread work every 45 s per account.
  it('neither scans nor sends while the background split is off, even with a provider', async () => {
    const account = addAccount('acct-a', [reply('t1'), plain('n1')]);
    const svc = await load();
    svc.setAIProviderConfigured(true);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * INTERVAL_MS);
    expect(account.calls).toEqual([]);
    expect(account.skipped).toEqual([]);
    expect(sent()).toEqual([]);

    // Switched on: the next pass nominates.
    svc.setBackgroundSplitEnabled(true);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toEqual([{ channel: CHANNEL, payload: { refs: [{ accountId: 'acct-a', threadId: 't1' }] } }]);
    svc.stopConversationScheduler();
  });

  // The switch alone is not enough: without a provider nothing could split.
  it('does nothing with the switch on but no provider', async () => {
    const account = addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    svc.setBackgroundSplitEnabled(true);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS + INTERVAL_MS);
    expect(account.calls).toEqual([]);
    svc.stopConversationScheduler();
  });

  // Regression: refs sent while the renderer dropped them sat out a 10-minute
  // cool-down, so the newest candidates waited that long after the user
  // switched the split on. Switching it on starts from a clean slate.
  it('forgets cool-downs when switched on, so nothing waits out one earned while it was dropped', async () => {
    addAccount('acct-a', [reply('t1')]);
    const svc = await load();
    enable(svc);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(sent()).toHaveLength(1);

    svc.setBackgroundSplitEnabled(false);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toHaveLength(1);
    svc.setBackgroundSplitEnabled(true);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toHaveLength(2);
    expect(sent()[1].payload.refs).toEqual([{ accountId: 'acct-a', threadId: 't1' }]);

    // Re-reporting "on" while already on keeps the cool-downs (no re-send storm).
    svc.setBackgroundSplitEnabled(true);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toHaveLength(2);
    svc.stopConversationScheduler();
  });
});

describe('the 30-day backlog', () => {
  const tick = async (svc: Scheduler) => {
    enable(svc);
    svc.startConversationScheduler();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
  };
  const ids = (index: number) => sent()[index]!.payload.refs.map((ref: { threadId: string }) => ref.threadId);

  // Regression: the evidence filter ran AFTER the scan's slot limit, and
  // nothing ever settled a non-reply thread, so the newest ~100 of them held
  // every slot for good and an older looped-in 'Fwd:' was never pre-split.
  it('nominates an older Fwd: behind 150 newer threads without reply evidence, on the first pass', async () => {
    const account = addAccount('acct-a', [
      ...Array.from({ length: 150 }, (_, i) => plain(`news${i}`)),
      reply('fwd', { subject: 'Fwd: Budget from the partner', inReplyTo: null }),
    ]);
    const svc = await load();
    await tick(svc);
    expect(sent()).toEqual([{ channel: CHANNEL, payload: { refs: [{ accountId: 'acct-a', threadId: 'fwd' }] } }]);
    // The 150 are retired in the same pass: they leave the candidate set.
    expect(account.skipped.flat()).toHaveLength(150);
    expect(account.candidates.map((candidate) => candidate.threadId)).toEqual(['fwd']);
    svc.stopConversationScheduler();
  });

  // The scan examines a bounded number of threads per pass (main-thread cost),
  // so a deeper backlog drains over passes instead of stalling one: every
  // pass retires what it met and the next reaches further.
  it('drains a deeper backlog pass by pass and still reaches the forward', async () => {
    const perPass = 20 * ROWS_PER_SLOT;
    const account = addAccount('acct-a', [
      ...Array.from({ length: 2 * perPass + 50 }, (_, i) => plain(`news${i}`)),
      reply('fwd', { subject: 'Fwd: Budget', inReplyTo: null }),
    ]);
    const svc = await load();
    expect(svc.CANDIDATE_SCAN_LIMIT).toBe(20);
    await tick(svc);
    expect(sent()).toEqual([]);
    expect(account.skipped[0]).toHaveLength(perPass);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(ids(0)).toEqual(['fwd']);
    expect(account.skipped.flat()).toHaveLength(2 * perPass + 50);
    svc.stopConversationScheduler();
  });

  // A thread with evidence is never retired — not even while it cools down
  // (the renderer could not decide it yet) — and cooling ones take no slot,
  // so the pass reaches the next ones.
  it('never retires a reply, and cooling replies do not hide the ones behind them', async () => {
    const account = addAccount('acct-a', Array.from({ length: 12 }, (_, i) => reply(`t${i}`)));
    const svc = await load();
    await tick(svc);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect([ids(0), ids(1), ids(2)]).toEqual([
      ['t0', 't1', 't2', 't3', 't4'], ['t5', 't6', 't7', 't8', 't9'], ['t10', 't11'],
    ]);
    expect(account.skipped).toEqual([]);
    svc.stopConversationScheduler();
  });

  // Failure path: a retire that fails (database locked) must not cost the
  // pass its nominations, and the threads are retired on the next pass
  // (idempotent re-run: nothing is nominated twice).
  it('still nominates when the retire fails, and retires on the next pass', async () => {
    const account = addAccount('acct-a', [plain('n1'), reply('t1')], { skipThrows: true });
    const svc = await load();
    await tick(svc);
    expect(ids(0)).toEqual(['t1']);
    expect(account.skipped).toEqual([]);

    account.skipThrows = false;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(account.skipped).toEqual([['n1']]);
    expect(sent()).toHaveLength(1);
    svc.stopConversationScheduler();
  });

  // Multi-account: each account retires in its OWN database — the same thread
  // id elsewhere is a different thread.
  it('retires per account', async () => {
    const a = addAccount('acct-a', [plain('n1')]);
    const b = addAccount('acct-b', [plain('n1'), plain('n2')]);
    const svc = await load();
    await tick(svc);
    expect(a.skipped).toEqual([['n1']]);
    expect(b.skipped).toEqual([['n1', 'n2']]);
    svc.stopConversationScheduler();
  });
});

describe('hasReplyEvidence', () => {
  it('reads In-Reply-To, References and the subject prefix', async () => {
    const { hasReplyEvidence } = await load();
    expect(hasReplyEvidence({ subject: 'x', inReplyTo: '<a@b>', references: null })).toBe(true);
    expect(hasReplyEvidence({ subject: 'x', inReplyTo: null, references: '<a@b>' })).toBe(true);
    expect(hasReplyEvidence({ subject: 'Re: x', inReplyTo: null, references: null })).toBe(true);
    expect(hasReplyEvidence({ subject: 'x', inReplyTo: ' ', references: '' })).toBe(false);
  });
});
