import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IEmailStorage } from '../../../src/types/storage';
import { planFolderDrift } from '../../../src/utils/folder-drift';


/**
 * END-TO-END for the one webmail change no COUNT can see: a star removed.
 *
 * `folder-drift.test.ts` proves the policy in isolation; this proves the WIRING,
 * which is where it would really break — the STATUS call has to actually ask for
 * HIGHESTMODSEQ, `syncFlags` has to actually persist it, and the two have to be
 * comparable. Each of those is a separate file, and a mistake in any one of them
 * leaves the pure function correct and the feature dead.
 *
 * The regression: unstarring in webmail changes neither `unseen` nor `messages`,
 * and IDLE watches INBOX only — so outside INBOX nothing whatsoever signalled the
 * change, and the star stayed in our list indefinitely. Every test below asserts
 * the counts held STILL across the change, so the modseq is provably the only
 * thing that could have triggered the reconcile.
 */

const FOLDER = 'Archive';
let folderSeq = 0;

interface Ctx {
  server: FakeImapServer;
  db: FakeEmailStorage;
  mp: MessageProcessor;
  folder: () => ReturnType<FakeEmailStorage['folder']>;
  storage: IEmailStorage;
}

function setup(options: { condstore?: boolean } = {}): Ctx {
  resetFakeMessageIds();
  resetFakeStorageIds();
  folderSeq += 1;
  const server = new FakeImapServer({ condstore: options.condstore ?? true });
  const db = new FakeEmailStorage();
  server.addFolder(FOLDER, { uidValidity: 1 });
  db.addFolder(FOLDER, { id: `f-${FOLDER}-${folderSeq}`, uidValidity: 1 });
  return {
    server,
    db,
    mp: new MessageProcessor(),
    folder: () => db.folder(FOLDER),
    storage: db.asStorage(),
  };
}

/** A starred, unread message on the server with a matching local row. */
function seedStarred(ctx: Ctx): number {
  const uid = ctx.server.addMessage(FOLDER, { flags: ['\\Flagged'] });
  ctx.db.seedEmail({
    folderId: ctx.db.folderId(FOLDER),
    uid,
    tags: `|${FOLDER}|starred|`,
  });
  return uid;
}

const tagsAt = (ctx: Ctx, uid: number): string[] => {
  const row = ctx.db.rowsPrimaryIn(FOLDER).find((e) => e.uid === uid);
  return row ? ctx.db.tagsOf(row.id).sort() : [];
};

/** One sweep: STATUS the folder and ask the planner what it implies. */
async function sweep(ctx: Ctx, previousUnseen?: number) {
  const st = await ctx.server.getFolderStatus(FOLDER);
  const f = ctx.folder();
  const plan = planFolderDrift({
    previousUnseen,
    currentUnseen: st.unseen ?? 0,
    serverMessages: st.messages ?? 0,
    localTotal: f.totalCount ?? 0,
    localUnread: f.unreadCount ?? 0,
    serverModseq: st.highestModseq,
    syncedModseq: f.highestModseq,
    serverUidValidity: st.uidValidity,
    localUidValidity: f.uidValidity,
  });
  return { status: st, plan };
}

/**
 * What the sweep does when the plan says the flags drifted — reconcile the rows
 * then recount FROM them, mirroring `applyFolderDrift`. The recount matters to
 * the test as much as to the app: leave the stored counts stale and the planner's
 * unit-independent first-look check fires on the disagreement, masking whether
 * the modseq trigger did any work at all.
 */
async function reconcileFlags(ctx: Ctx): Promise<number> {
  await ctx.server.selectFolder(FOLDER);
  const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
  await ctx.storage.recalculateFolderCounts?.([FOLDER]);
  return res.updated;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('star removed in webmail, outside INBOX (CONDSTORE)', () => {
  it('notices the unstar, drops the tag, and goes quiet again', async () => {
    const ctx = setup({ condstore: true });
    const uid = seedStarred(ctx);

    // Baseline: one flag sync, after which the folder is current and quiet.
    await reconcileFlags(ctx);
    const settled = await sweep(ctx);
    expect(settled.plan.reconcileFlags).toBe(false);
    expect(tagsAt(ctx, uid)).toContain('starred');

    // Webmail unstars it. Nothing a count can see moves.
    ctx.server.setFlagsOnServer(FOLDER, uid, []);

    const drifted = await sweep(ctx, settled.status.unseen);
    // The load-bearing assertion: the counts are IDENTICAL across the change, so
    // only the modseq can have triggered this. Under the old unseen-only trigger
    // this plan was `false` and the star was never removed.
    expect(drifted.status.unseen).toBe(settled.status.unseen);
    expect(drifted.status.messages).toBe(settled.status.messages);
    expect(drifted.plan.reconcileFlags).toBe(true);

    // A flags-only change must not drag in the far more expensive content sync.
    expect(drifted.plan.reconcileDeletions).toBe(false);

    expect(await reconcileFlags(ctx)).toBe(1);
    expect(tagsAt(ctx, uid)).not.toContain('starred');

    // Self-clearing: the reconcile advanced the stored modseq, so the next sweep
    // is a no-op. Without this the folder would reconcile on every sweep forever.
    const after = await sweep(ctx, drifted.status.unseen);
    expect(after.plan.reconcileFlags).toBe(false);
  });

  it('notices a star ADDED in webmail too', async () => {
    // The reverse direction: starring in webmail must reach our list, not just
    // unstarring. Same blind spot — no count moves either way.
    const ctx = setup({ condstore: true });
    const uid = ctx.server.addMessage(FOLDER, { flags: [] });
    ctx.db.seedEmail({ folderId: ctx.db.folderId(FOLDER), uid, tags: `|${FOLDER}|` });

    await reconcileFlags(ctx);
    const settled = await sweep(ctx);
    expect(settled.plan.reconcileFlags).toBe(false);

    ctx.server.setFlagsOnServer(FOLDER, uid, ['\\Flagged']);

    const drifted = await sweep(ctx, settled.status.unseen);
    expect(drifted.status.unseen).toBe(settled.status.unseen);
    expect(drifted.plan.reconcileFlags).toBe(true);

    await reconcileFlags(ctx);
    expect(tagsAt(ctx, uid)).toContain('starred');
  });

  it('stays quiet across repeated sweeps when nothing changed', async () => {
    // The cost guard. A trigger that fires on a quiet folder re-FETCHes every
    // flag in every folder every five minutes, on every account.
    const ctx = setup({ condstore: true });
    seedStarred(ctx);
    await reconcileFlags(ctx);

    let previousUnseen: number | undefined;
    for (let i = 0; i < 3; i += 1) {
      const { status, plan } = await sweep(ctx, previousUnseen);
      expect(plan.reconcileFlags).toBe(false);
      expect(plan.reconcileDeletions).toBe(false);
      previousUnseen = status.unseen;
    }
  });

  it('still notices a mail READ in webmail (the unseen path is intact)', async () => {
    // Regression guard on the change itself: adding the modseq trigger must not
    // have broken the count-based one it sits alongside.
    const ctx = setup({ condstore: true });
    const uid = ctx.server.addMessage(FOLDER, { flags: [] });
    ctx.db.seedEmail({ folderId: ctx.db.folderId(FOLDER), uid, tags: `|${FOLDER}|` });
    await reconcileFlags(ctx);
    const settled = await sweep(ctx);

    ctx.server.setFlagsOnServer(FOLDER, uid, ['\\Seen']);

    const drifted = await sweep(ctx, settled.status.unseen);
    expect(drifted.status.unseen).not.toBe(settled.status.unseen); // this one IS visible to a count
    expect(drifted.plan.reconcileFlags).toBe(true);

    await reconcileFlags(ctx);
    expect(tagsAt(ctx, uid)).toContain('read');
  });
});

describe('star removed in webmail, on a server WITHOUT CONDSTORE', () => {
  // KNOWN, DELIBERATE LIMITATION — not an accident, and not a bug to "fix" by
  // loosening the trigger. Without CONDSTORE the server offers no signal at all
  // for a \Flagged change: `unseen` and `messages` both hold still, so the sweep
  // has nothing to key on. The star is picked up the next time something else
  // moves the unread count in this folder, or on a full folder sync.
  //
  // The alternative — re-FETCHing every flag in every folder on every sweep — is
  // the runaway this module was written to prevent, so the gap is priced in
  // rather than closed. Asserted here so the next person can tell the difference
  // between a limitation and a regression.
  it('does NOT notice an unstar (documented gap: no signal exists)', async () => {
    const ctx = setup({ condstore: false });
    const uid = seedStarred(ctx);
    await reconcileFlags(ctx);
    const settled = await sweep(ctx);
    expect(settled.status.highestModseq).toBeUndefined();

    ctx.server.setFlagsOnServer(FOLDER, uid, []);

    const drifted = await sweep(ctx, settled.status.unseen);
    expect(drifted.plan.reconcileFlags).toBe(false);
  });

  it('still notices a mail read in webmail', async () => {
    // The fallback must carry the whole decision on these servers.
    const ctx = setup({ condstore: false });
    const uid = ctx.server.addMessage(FOLDER, { flags: [] });
    ctx.db.seedEmail({ folderId: ctx.db.folderId(FOLDER), uid, tags: `|${FOLDER}|` });
    await reconcileFlags(ctx);
    const settled = await sweep(ctx);

    ctx.server.setFlagsOnServer(FOLDER, uid, ['\\Seen']);

    const drifted = await sweep(ctx, settled.status.unseen);
    expect(drifted.plan.reconcileFlags).toBe(true);
  });
});
