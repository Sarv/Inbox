import { describe, it, expect, vi } from 'vitest';

import { applyFolderDrift, planFolderDrift } from '../../../src/utils/folder-drift';

/**
 * The STATUS-poll policy for non-INBOX folders. IDLE watches INBOX only, so this
 * is the ONLY thing that notices a mail read/starred in webmail anywhere else —
 * and the historical bug was that it compared the server's MESSAGE `unseen`
 * against our DISTINCT-THREAD `unreadCount`, which made the trigger either
 * permanently true (endless reconciles) or, once written into the badge, a number
 * that disagreed with the list it labelled.
 */
describe('planFolderDrift', () => {
  const base = { currentUnseen: 0, serverMessages: 10, localTotal: 10, localUnread: 0 };

  describe('flag reconcile — steady state (a baseline exists)', () => {
    // Regression: mail read/unread in webmail must be picked up. The server's own
    // unseen moved between two sweeps — like-for-like, no unit assumption.
    it('reconciles when the server unread count moved since the last sweep', () => {
      expect(planFolderDrift({ ...base, previousUnseen: 30, currentUnseen: 9 }).reconcileFlags).toBe(true);
    });

    // Regression: unstarring/unreading upward is drift too, not just downward.
    it('reconciles when the server unread count grew', () => {
      expect(planFolderDrift({ ...base, previousUnseen: 9, currentUnseen: 30 }).reconcileFlags).toBe(true);
    });

    // Regression (the loop): a folder holding one unread THREAD of two messages
    // reports unseen=2 against unreadCount=1 forever. Comparing the two units
    // re-reconciled every folder on every sweep; comparing unseen to unseen does not.
    it('does NOT reconcile when the server number is unchanged, even if our thread count differs', () => {
      const plan = planFolderDrift({
        ...base,
        previousUnseen: 2,
        currentUnseen: 2,
        localUnread: 1, // 1 unread thread == 2 unread messages: agreement, not drift
      });
      expect(plan.reconcileFlags).toBe(false);
    });

    // Idempotent re-run: sweeping twice with no server activity must be a no-op.
    it('is a no-op on an unchanged repeat sweep', () => {
      const input = { ...base, previousUnseen: 0, currentUnseen: 0 };
      expect(planFolderDrift(input).reconcileFlags).toBe(false);
      expect(planFolderDrift(input).reconcileFlags).toBe(false);
    });
  });

  describe('flag reconcile — first look (no baseline: fresh start / after restart)', () => {
    // Regression: with no baseline we must still catch a provable disagreement —
    // "some unread" vs "none" means the same thing in messages and in threads.
    it('reconciles when the server has unread mail and we show none', () => {
      const plan = planFolderDrift({ ...base, previousUnseen: undefined, currentUnseen: 4, localUnread: 0 });
      expect(plan.reconcileFlags).toBe(true);
    });

    // Regression: the reverse — everything was read in webmail while we were shut
    // down, so our unread rows are stale and the badge is wrong.
    it('reconciles when we show unread mail and the server has none', () => {
      const plan = planFolderDrift({ ...base, previousUnseen: undefined, currentUnseen: 0, localUnread: 7 });
      expect(plan.reconcileFlags).toBe(true);
    });

    // Regression (the loop, first-look edition): both sides agree there IS unread
    // mail, and the differing magnitudes are just the unit difference — no reconcile.
    it('does NOT reconcile when both sides have some unread mail but the counts differ', () => {
      const plan = planFolderDrift({ ...base, previousUnseen: undefined, currentUnseen: 12, localUnread: 5 });
      expect(plan.reconcileFlags).toBe(false);
    });

    it('does NOT reconcile when both sides agree the folder has no unread mail', () => {
      const plan = planFolderDrift({ ...base, previousUnseen: undefined, currentUnseen: 0, localUnread: 0 });
      expect(plan.reconcileFlags).toBe(false);
    });
  });

  /**
   * The CONDSTORE trigger. `unseen` and `messages` are both blind to a \Flagged
   * change, so before this existed a star removed in webmail outside INBOX was
   * invisible — IDLE watches INBOX only, and no STATUS count moves. Every test
   * here holds the counts in agreement so only the modseq can decide.
   */
  describe('flag reconcile — CONDSTORE modseq', () => {
    // THE regression this trigger exists for: unstarring in webmail moves no
    // count at all. Without the modseq comparison the star stays in our list
    // until some unrelated unread change happens to reconcile the same folder.
    it('reconciles when the server modseq ran ahead of our synced modseq', () => {
      const plan = planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: 4207 });
      expect(plan.reconcileFlags).toBe(true);
    });

    // Anti-loop: once syncFlags has applied everything up to the server's modseq
    // and persisted it, the folder must go quiet again.
    it('does NOT reconcile when the synced modseq has caught up', () => {
      const plan = planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: 4210 });
      expect(plan.reconcileFlags).toBe(false);
    });

    // Regression (`>` not `!==`): the reconcile persists the modseq seen at its
    // SELECT, which can be HIGHER than the STATUS value that triggered it when
    // another change lands in between. Compared with `!==` that gap re-triggers
    // on every sweep forever — a permanent reconcile loop on a busy folder.
    it('does NOT reconcile when our synced modseq is AHEAD of the STATUS value', () => {
      const plan = planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: 4215 });
      expect(plan.reconcileFlags).toBe(false);
    });

    // Self-clearing end to end: drift, then the reconcile advances the baseline,
    // then the next sweep is a no-op. This is the property that keeps the sweep
    // cheap on a quiet account.
    it('clears itself after one reconcile advances the baseline', () => {
      expect(planFolderDrift({ ...base, serverModseq: 90, syncedModseq: 88 }).reconcileFlags).toBe(true);
      expect(planFolderDrift({ ...base, serverModseq: 90, syncedModseq: 90 }).reconcileFlags).toBe(false);
    });

    // Regression: a non-CONDSTORE server reports no modseq at all. It must fall
    // straight through to the unseen logic, never behave as if 'absent' were a
    // change — that would reconcile every folder on every sweep.
    it('falls back to the unseen comparison when the server reports no modseq', () => {
      expect(planFolderDrift({ ...base, serverModseq: undefined, syncedModseq: 4207 }).reconcileFlags).toBe(false);
      expect(planFolderDrift({
        ...base, serverModseq: undefined, syncedModseq: 4207, previousUnseen: 5, currentUnseen: 2,
      }).reconcileFlags).toBe(true);
    });

    // Regression: a folder we have never flag-synced has no baseline to compare
    // against. Absent must not read as zero, or every such folder reconciles on
    // every sweep from a modseq that is trivially "ahead" of 0.
    it('does not use the modseq before the folder has ever been flag-synced', () => {
      expect(planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: null }).reconcileFlags).toBe(false);
      expect(planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: undefined }).reconcileFlags).toBe(false);
      expect(planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: 0 }).reconcileFlags).toBe(false);
    });

    // Regression: some servers answer 0 for a mailbox with no modseq support.
    // Treating that as a real value would compare against garbage.
    it('ignores a zero modseq from the server', () => {
      expect(planFolderDrift({ ...base, serverModseq: 0, syncedModseq: 4207 }).reconcileFlags).toBe(false);
    });

    // The two signals are OR'd, not else-if'd: a server whose modseq is frozen or
    // stale must still be caught by the count comparison.
    it('still reconciles on an unseen change when the modseq has not moved', () => {
      const plan = planFolderDrift({
        ...base, serverModseq: 4210, syncedModseq: 4210, previousUnseen: 5, currentUnseen: 2,
      });
      expect(plan.reconcileFlags).toBe(true);
    });

    // A star change is flags-only — it must NOT drag in the expensive content sync.
    it('does not trigger the content sync for a modseq-only change', () => {
      const plan = planFolderDrift({ ...base, serverModseq: 4210, syncedModseq: 4207 });
      expect(plan).toEqual({ reconcileFlags: true, reconcileDeletions: false });
    });
  });

  /**
   * UIDVALIDITY (RFC 3501 §2.3.1.1): the server rebuilt the folder, so every UID
   * we hold and BOTH baselines above describe a mailbox that no longer exists.
   */
  describe('flag reconcile — uidValidity change', () => {
    // Regression: after a rebuild the server's modseq typically restarts LOW, so
    // the modseq trigger reads "behind" and the counts can coincidentally agree —
    // the folder would silently never reconcile despite every row being stale.
    it('reconciles both halves when uidValidity changed, even with a lower modseq', () => {
      const plan = planFolderDrift({
        ...base, serverUidValidity: 99, localUidValidity: 42, serverModseq: 2, syncedModseq: 5000,
      });
      expect(plan).toEqual({ reconcileFlags: true, reconcileDeletions: true });
    });

    // The normal case must stay quiet, or every sweep reconciles every folder.
    it('does NOT reconcile when uidValidity is unchanged', () => {
      const plan = planFolderDrift({
        ...base, serverUidValidity: 42, localUidValidity: 42, serverModseq: 90, syncedModseq: 90,
      });
      expect(plan.reconcileFlags).toBe(false);
    });

    // Regression: a missing value on either side is "unknown", not "changed".
    // Reading absent as a difference would reconcile every folder we have not
    // recorded a uidValidity for.
    it('treats an absent uidValidity on either side as no evidence', () => {
      expect(planFolderDrift({ ...base, serverUidValidity: 42, localUidValidity: null }).reconcileFlags).toBe(false);
      expect(planFolderDrift({ ...base, serverUidValidity: undefined, localUidValidity: 42 }).reconcileFlags).toBe(false);
      expect(planFolderDrift({ ...base, serverUidValidity: 0, localUidValidity: 42 }).reconcileFlags).toBe(false);
    });
  });

  describe('deletion reconcile', () => {
    // Regression: server-side deletes (webmail trash, retention expiry, a move out
    // of the folder) are invisible without this — non-INBOX gets no IDLE.
    it('reconciles content when the server holds fewer messages than we do', () => {
      expect(planFolderDrift({ ...base, serverMessages: 8, localTotal: 10 }).reconcileDeletions).toBe(true);
    });

    // Regression: we must NOT run the expensive content sync just because the
    // server has MORE mail — that is an arrival, which the normal sync covers.
    it('does not reconcile content when the server holds more messages than we do', () => {
      expect(planFolderDrift({ ...base, serverMessages: 12, localTotal: 10 }).reconcileDeletions).toBe(false);
    });

    it('does not reconcile content when the totals match', () => {
      expect(planFolderDrift({ ...base, serverMessages: 10, localTotal: 10 }).reconcileDeletions).toBe(false);
    });
  });

  // Regression: the two decisions are independent. A folder where mail was both
  // read and deleted in webmail must get both, and a flag-only change must not
  // drag in the far more expensive content sync.
  it('decides the two reconciles independently', () => {
    expect(planFolderDrift({ previousUnseen: 5, currentUnseen: 1, serverMessages: 8, localTotal: 10, localUnread: 3 }))
      .toEqual({ reconcileFlags: true, reconcileDeletions: true });
    expect(planFolderDrift({ previousUnseen: 5, currentUnseen: 1, serverMessages: 10, localTotal: 10, localUnread: 3 }))
      .toEqual({ reconcileFlags: true, reconcileDeletions: false });
  });
});

/**
 * Carrying out a plan. The non-INBOX sweep is the ONLY thing that notices a mail
 * read/starred in webmail outside INBOX (IDLE watches INBOX only), so the order
 * here is load-bearing: reconcile the ROWS, recount FROM the rows, and only then
 * tell the renderer — which re-runs that folder's list query. Getting it wrong
 * shows up as a badge that disagrees with the list, or a list still showing
 * pre-reconcile read state.
 */
describe('applyFolderDrift', () => {
  const folder = { path: 'Archive', unreadCount: 5, totalCount: 100 };

  const makeTargets = (over: Record<string, any> = {}) => {
    const calls: string[] = [];
    const targets = {
      refreshFolderFlags: vi.fn(async () => { calls.push('flags'); return 3; }),
      syncFolderContent: vi.fn(async () => { calls.push('content'); }),
      recount: vi.fn(async () => { calls.push('recount'); }),
      readCounts: vi.fn(async () => { calls.push('read'); return { unreadCount: 1, totalCount: 100 }; }),
      notify: vi.fn(() => { calls.push('notify'); }),
      onError: vi.fn(),
      ...over,
    };
    return { targets, calls };
  };

  // Regression: the badge is recomputed from the rows AFTER they are reconciled,
  // and the renderer is told only once both are done. Any other order publishes
  // a count that disagrees with what the list would return.
  it('reconciles rows, recounts, then notifies — in that order', async () => {
    const { targets, calls } = makeTargets();
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, targets as any);
    expect(calls).toEqual(['flags', 'recount', 'read', 'notify']);
  });

  // Regression: a quiet folder must not re-run the renderer's list query on
  // every 5-minute sweep — that is a full query + re-render for no change.
  it('does not notify when nothing actually moved', async () => {
    const { targets } = makeTargets({
      refreshFolderFlags: vi.fn(async () => 0),
      readCounts: vi.fn(async () => ({ unreadCount: 5, totalCount: 100 })), // identical to before
    });
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, targets as any);
    expect(targets.recount).toHaveBeenCalledTimes(1); // still cheap-recounted
    expect(targets.notify).not.toHaveBeenCalled();
  });

  // Regression: QRESYNC's VANISHED pass inside the flag refresh REMOVES rows
  // without touching a single flag, so `updated === 0` while the counts moved.
  // Gating the notify on `updated` alone left those deletions on screen.
  it('notifies when the counts moved even though no flag changed', async () => {
    const { targets } = makeTargets({
      refreshFolderFlags: vi.fn(async () => 0),
      readCounts: vi.fn(async () => ({ unreadCount: 5, totalCount: 92 })), // 8 rows vanished
    });
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, targets as any);
    expect(targets.notify).toHaveBeenCalledWith('Archive');
  });

  it('notifies when rows changed even though the totals happen to match', async () => {
    const { targets } = makeTargets({
      refreshFolderFlags: vi.fn(async () => 4),
      readCounts: vi.fn(async () => ({ unreadCount: 5, totalCount: 100 })), // e.g. 4 stars toggled
    });
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, targets as any);
    expect(targets.notify).toHaveBeenCalledWith('Archive');
  });

  // Transient failure (connection blip / timeout): report and move on. Throwing
  // would abort the sweep and every FOLLOWING folder would go unreconciled.
  it('reports a flag-reconcile failure without throwing, and still runs the deletion pass', async () => {
    const { targets } = makeTargets({
      refreshFolderFlags: vi.fn(async () => { throw new Error('flag reconcile timed out'); }),
    });
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: true }, folder, targets as any);
    expect(targets.onError).toHaveBeenCalledWith('flags', 'Archive', expect.any(Error));
    expect(targets.notify).not.toHaveBeenCalled(); // nothing was reconciled — don't claim it was
    expect(targets.syncFolderContent).toHaveBeenCalledWith('Archive');
  });

  // A recount failure must not be reported as success either: the badge would be
  // stale while the renderer was told to re-read it.
  it('reports a recount failure and does not notify', async () => {
    const { targets } = makeTargets({
      recount: vi.fn(async () => { throw new Error('db busy'); }),
    });
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, targets as any);
    expect(targets.onError).toHaveBeenCalledWith('flags', 'Archive', expect.any(Error));
    expect(targets.notify).not.toHaveBeenCalled();
  });

  it('reports a deletion-reconcile failure without throwing', async () => {
    const { targets } = makeTargets({
      syncFolderContent: vi.fn(async () => { throw new Error('deletion-reconcile timed out'); }),
    });
    await applyFolderDrift({ reconcileFlags: false, reconcileDeletions: true }, folder, targets as any);
    expect(targets.onError).toHaveBeenCalledWith('deletions', 'Archive', expect.any(Error));
  });

  // Regression: a flag-only drift must NOT drag in the far more expensive
  // content sync (a full folder UID diff), and vice versa.
  it('runs only the pass the plan asked for', async () => {
    const flagsOnly = makeTargets();
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, flagsOnly.targets as any);
    expect(flagsOnly.targets.syncFolderContent).not.toHaveBeenCalled();

    const deletionsOnly = makeTargets();
    await applyFolderDrift({ reconcileFlags: false, reconcileDeletions: true }, folder, deletionsOnly.targets as any);
    expect(deletionsOnly.targets.refreshFolderFlags).not.toHaveBeenCalled();
    expect(deletionsOnly.targets.recount).not.toHaveBeenCalled();
  });

  // An empty plan is the common case (most folders, most sweeps): it must cost
  // nothing beyond the STATUS the caller already did.
  it('does nothing at all for an empty plan', async () => {
    const { targets, calls } = makeTargets();
    await applyFolderDrift({ reconcileFlags: false, reconcileDeletions: false }, folder, targets as any);
    expect(calls).toEqual([]);
    expect(targets.onError).not.toHaveBeenCalled();
  });

  // A folder we have never counted (fresh account) must still be handled: the
  // undefined stored counts read as 0, so any real count is a change.
  it('treats a folder with no stored counts as changed', async () => {
    const { targets } = makeTargets({ refreshFolderFlags: vi.fn(async () => 0) });
    await applyFolderDrift(
      { reconcileFlags: true, reconcileDeletions: false },
      { path: 'Archive' },
      targets as any,
    );
    expect(targets.notify).toHaveBeenCalledWith('Archive');
  });

  // readCounts returning null (folder row gone mid-sweep) must not crash the
  // sweep; it reads as zeroed counts, which for a folder we held rows for IS a
  // change worth publishing.
  it('tolerates the folder row disappearing mid-sweep', async () => {
    const { targets } = makeTargets({
      refreshFolderFlags: vi.fn(async () => 0),
      readCounts: vi.fn(async () => null),
    });
    await applyFolderDrift({ reconcileFlags: true, reconcileDeletions: false }, folder, targets as any);
    expect(targets.onError).not.toHaveBeenCalled();
    expect(targets.notify).toHaveBeenCalledWith('Archive');
  });
});
