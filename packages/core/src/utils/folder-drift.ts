/**
 * Deciding what a STATUS poll of a folder tells us to do.
 *
 * IMAP pushes nothing outside the one mailbox IDLE watches, so every OTHER
 * folder learns about webmail activity from a periodic `STATUS` poll: cheap
 * counts, no download. Turning those counts into "reconcile this folder" is the
 * part that is easy to get wrong, in two specific ways this module exists to
 * prevent:
 *
 *  1. **Comparing unlike units.** The server's `unseen` is a MESSAGE count. Our
 *     stored `unreadCount` is a DISTINCT-THREAD count (that is what the list
 *     renders, so that is what the badge must show). Any folder holding an
 *     unread thread with two messages makes `unseen !== unreadCount` true
 *     FOREVER — so a reconcile keyed on that inequality re-runs on every sweep,
 *     for every folder, forever.
 *  2. **Writing the server's number into our badge.** It disagrees with the
 *     list by construction (see 1), and the next recount recomputes it from the
 *     rows anyway, so the badge visibly flips back and forth. The rows are the
 *     single source of truth: reconcile them, then recount from them.
 *
 * The flag-reconcile trigger is therefore, in order of strength:
 *
 *  1. **UIDVALIDITY changed** — the server rebuilt the folder, so every UID we
 *     hold and every baseline below refers to a mailbox that no longer exists.
 *  2. **CONDSTORE `HIGHESTMODSEQ` ran ahead of the modseq our rows were last
 *     synced at.** The only signal that sees a `\Flagged` change: `unseen` and
 *     `messages` are both blind to a star removed in webmail, so before this
 *     existed an unstar outside INBOX was invisible until something unrelated
 *     happened to move the unread count in the same folder. Durable (the
 *     baseline is `FolderRecord.highestModseq`, not an in-memory value) so it
 *     survives a restart, and self-clearing because the reconcile advances it.
 *  3. **`unseen` moved between two sweeps** (like-for-like: unseen vs unseen) —
 *     the fallback for servers without CONDSTORE, plus one unit-independent
 *     first-look check: the server and we disagree about whether the folder has
 *     ANY unread mail at all, which is wrong no matter how you count it, and
 *     which self-clears after one reconcile.
 *
 * Separately from the network half, every sweep answers one purely LOCAL
 * question: does our stored badge disagree with the server about this folder
 * holding any unread mail at all? If so the counts are recomputed from our own
 * rows (`recountFromRows`) — no FETCH, one indexed query — because
 * `folders.unread_count` is a hand-maintained scalar and a single write path
 * that forgets its decrement strands the sidebar badge above an empty list for
 * the rest of the session.
 *
 * Pure and side-effect free, so the policy is unit-testable without an IMAP
 * server; the caller owns the polling, the timeouts and the previous-value map.
 */

export interface FolderDriftInput {
  /** `unseen` from the previous sweep of this folder; undefined on first look. */
  previousUnseen?: number;
  /** `unseen` the server just reported. */
  currentUnseen: number;
  /** `messages` the server just reported. */
  serverMessages: number;
  /** Our stored message count for the folder (same unit as `messages`). */
  localTotal: number;
  /** Our stored unread count — DISTINCT THREADS, so never compared by value. */
  localUnread: number;
  /**
   * `HIGHESTMODSEQ` the server just reported. Absent on a server without
   * CONDSTORE, in which case the `unseen` fallback carries the whole decision.
   */
  serverModseq?: number;
  /**
   * `FolderRecord.highestModseq` — the modseq our stored rows are known-current
   * as of, written by `syncFlags` once it has applied every change up to it.
   * Null/0 until the folder's first flag sync.
   */
  syncedModseq?: number | null;
  /** `UIDVALIDITY` the server just reported. */
  serverUidValidity?: number;
  /** `FolderRecord.uidValidity` — what our stored rows were synced under. */
  localUidValidity?: number | null;
}

export interface FolderDriftPlan {
  /**
   * Re-fetch this folder's flags: something read/unread/starred changed on the
   * server (or our read state is provably wrong about this folder).
   */
  reconcileFlags: boolean;
  /**
   * Content-sync this folder so the (safety-guarded) deletion detection runs:
   * the server holds FEWER messages than we do.
   */
  reconcileDeletions: boolean;
  /**
   * Recompute this folder's stored counts FROM our own rows — no network.
   *
   * Set whenever the server and we disagree about the folder holding ANY unread
   * mail, on EVERY sweep rather than only the first look. `folders.unread_count`
   * is a stored scalar that many local paths adjust by hand, so a single missed
   * decrement leaves the sidebar badge counting threads the unread-filtered list
   * no longer shows, and nothing recomputes it until a sync happens to report a
   * mutation — which a quiet mailbox never does. A recount is one indexed local
   * query, so it is cheap enough to run on every disagreeing sweep, and it is
   * the exact repair for a badge that disagrees with the rows the list reads.
   *
   * Deliberately NOT a reason to reconcile flags in steady state: a disagreement
   * that survives the recount is a genuine row-level divergence, and re-FETCHing
   * a folder's flags on every sweep forever is the runaway this module exists to
   * prevent. The first-look reconcile and the modseq/unseen triggers still own
   * the network half.
   */
  recountFromRows: boolean;
}

/**
 * Whether the two sides disagree about the folder holding ANY unread mail.
 * Unit-independent — "some" vs "none" means the same in messages and threads —
 * so it is the one comparison worth making across the two counts.
 */
function disagreeOnAnyUnread(serverUnseen: number, localUnreadThreads: number): boolean {
  return (serverUnseen === 0) !== (localUnreadThreads === 0);
}

/**
 * A modseq/uidValidity we can actually reason about. Servers report 0 (and
 * ImapFlow reports undefined) for "no value" — treating that as a real number
 * would make `0 > 0` style comparisons decide policy on absent data.
 */
function isUsable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function planFolderDrift(input: FolderDriftInput): FolderDriftPlan {
  const {
    previousUnseen, currentUnseen, serverMessages, localTotal, localUnread,
    serverModseq, syncedModseq, serverUidValidity, localUidValidity,
  } = input;

  // The server rebuilt the folder (RFC 3501 §2.3.1.1). Our UIDs, our counts and
  // both baselines below describe a mailbox that no longer exists, so nothing
  // here can be compared — reconcile both halves and let the flag sync's own
  // uidValidity bail and the folder re-key sort the rows out.
  const uidValidityChanged =
    isUsable(serverUidValidity) && isUsable(localUidValidity) && serverUidValidity !== localUidValidity;

  // CONDSTORE: the server has moved PAST the point our rows were reconciled to,
  // so something changed — including the \Flagged change no count can see.
  //
  // Strictly `>`, never `!==`: the reconcile persists the modseq observed at its
  // SELECT, which can be HIGHER than the STATUS value that triggered it (another
  // change landing in between). Under `!==` that gap would re-trigger on every
  // sweep forever — the same runaway this module exists to prevent.
  const modseqAhead =
    isUsable(serverModseq) && isUsable(syncedModseq) && serverModseq > syncedModseq;

  // Unit-independent, so it is the one comparison worth making across the two
  // counts: "some" vs "none" means the same in messages as in threads.
  const anyUnreadDisagrees = disagreeOnAnyUnread(currentUnseen, localUnread);

  const unseenDrift = previousUnseen === undefined
    // First look this session: no like-for-like baseline yet, so act only on the
    // disagreement that cannot be a unit artefact. One reconcile fixes the rows
    // and the counts agree again, so this cannot loop.
    ? anyUnreadDisagrees
    // Steady state: the server's own number moved since we last asked, so
    // someone read or unread something in another client.
    : currentUnseen !== previousUnseen;

  return {
    // OR, not else-if: a server that reports a stale or frozen modseq must still
    // be caught by the count comparison, and vice versa.
    reconcileFlags: uidValidityChanged || modseqAhead || unseenDrift,
    reconcileDeletions: uidValidityChanged || serverMessages < localTotal,
    recountFromRows: anyUnreadDisagrees,
  };
}

/**
 * The side-effecting half, kept behind narrow injected operations so the ORDER
 * and the GATES are unit-testable without an IMAP server, an Electron main
 * process or a real database. The caller owns the timeouts, the logging and the
 * IPC channel; this owns only "what happens, in what order, and when do we tell
 * the renderer".
 */
export interface FolderDriftTargets {
  /** Re-fetch the folder's flags; resolves to the number of rows that changed. */
  refreshFolderFlags(folderPath: string): Promise<number>;
  /** Content-sync the folder so the guarded deletion detection runs. */
  syncFolderContent(folderPath: string): Promise<void>;
  /** Recompute the folder's stored counts FROM the rows (the single source of truth). */
  recount(folderPath: string): Promise<void>;
  /** Read the folder's stored counts back after the recount. */
  readCounts(folderPath: string): Promise<{ unreadCount?: number; totalCount?: number } | null>;
  /** Tell the renderer THIS folder moved, so it re-runs the folder's list query. */
  notify(folderPath: string): void;
  /** One reconcile failing must never sink the sweep — report and carry on. */
  onError(stage: 'flags' | 'deletions' | 'counts', folderPath: string, error: Error): void;
}

export interface FolderDriftSubject {
  path: string;
  /** Our stored counts BEFORE the reconcile, to detect whether anything moved. */
  unreadCount?: number;
  totalCount?: number;
}

/**
 * Carry out a {@link planFolderDrift} decision for one folder.
 *
 * Deliberately: reconcile the ROWS, then recount from them, then notify — never
 * write the server's `unseen` into our badge (wrong unit, see the module header)
 * and never notify without a real change, or a quiet folder would re-run the
 * renderer's list query on every sweep.
 */
/** Did the recount actually move either stored count? Only then is the renderer
 *  worth waking: a quiet folder must not re-run the list query every sweep. */
async function countsMoved(
  folder: FolderDriftSubject,
  targets: Pick<FolderDriftTargets, 'readCounts'>,
): Promise<boolean> {
  const after = await targets.readCounts(folder.path);
  return (
    (after?.unreadCount ?? 0) !== (folder.unreadCount ?? 0) ||
    (after?.totalCount ?? 0) !== (folder.totalCount ?? 0)
  );
}

export async function applyFolderDrift(
  plan: FolderDriftPlan,
  folder: FolderDriftSubject,
  targets: FolderDriftTargets,
): Promise<void> {
  if (plan.reconcileFlags) {
    try {
      const updated = await targets.refreshFolderFlags(folder.path);
      await targets.recount(folder.path);
      // `updated` counts rows whose flags moved; the count comparison also
      // catches a QRESYNC VANISHED pass, which removes rows without touching a
      // single flag.
      // Read the counts back BEFORE the `updated > 0` shortcut would skip it:
      // the comparison is the only thing that catches a QRESYNC VANISHED pass,
      // which removes rows without touching a single flag.
      const moved = await countsMoved(folder, targets);
      if (updated > 0 || moved) targets.notify(folder.path);
    } catch (error) {
      targets.onError('flags', folder.path, error as Error);
    }
  } else if (plan.recountFromRows) {
    // No network half to run, but our stored badge and the server disagree about
    // this folder holding any unread mail at all — recompute the badge from our
    // own rows, which is what the list reads. Costs one indexed local query and
    // is idempotent, so a disagreement the rows themselves carry cannot turn
    // this into a loop that does work.
    try {
      await targets.recount(folder.path);
      if (await countsMoved(folder, targets)) targets.notify(folder.path);
    } catch (error) {
      targets.onError('counts', folder.path, error as Error);
    }
  }

  if (plan.reconcileDeletions) {
    try {
      await targets.syncFolderContent(folder.path);
    } catch (error) {
      targets.onError('deletions', folder.path, error as Error);
    }
  }
}
