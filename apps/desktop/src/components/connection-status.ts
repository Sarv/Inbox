// Pure, dependency-free helpers for how connection/sync health is surfaced to
// the user (sidebar dot + the sync-trouble banner). Kept out of the React/store
// modules so the priority rules are unit-testable without a DOM render or the
// whole store graph. No imports on purpose.

export type ConnectionBarStatus = { dotClass: string; label: string; pulse: boolean };

/** The sync half of the bar's status snapshot. */
export type SyncBarStatus = {
  foldersCompleted: number;
  foldersTotal: number;
  percentComplete: number;
  messagesProcessed?: number;
};

/**
 * What the bar says while a sync runs.
 *
 * Leads with the folder pair, then the count of messages stored SO FAR. That
 * count is the point: the percentage beside it is folder-set relative and can
 * sit on one number for minutes while a single big mailbox streams in (and it
 * is already drawn, as the progress fill along the bottom edge of the bar), so
 * on a first sync the bar could read "5/6 folders (22%)" unchanged for long
 * enough that the user concludes the download has stalled. The message count
 * only ever climbs, which is the proof that mail is still arriving.
 */
const syncingLabel = (status: SyncBarStatus): string => {
  const folders = `${status.foldersCompleted}/${status.foldersTotal} folders`;
  const messages = status.messagesProcessed ?? 0;
  if (messages > 0) return `${folders} · ${messages.toLocaleString()} emails`;
  // Nothing stored yet (so percentComplete is 0 too): the folder pair alone.
  return status.percentComplete > 0 ? `${folders} (${status.percentComplete}%)` : folders;
};

/**
 * The sidebar connection dot. Five cases, in PRIORITY order:
 *   syncing → reconnecting → disconnected → sync-trouble → connected.
 * "Live" is the healthy steady state (IMAP IDLE push active); a plain "Connected"
 * is connected-but-not-yet-listening. "Sync issue" (amber) is the crucial
 * connected-but-mail-not-flowing state — the socket is up but sync keeps failing,
 * so the user is told rather than shown a reassuring green "Live" while nothing
 * arrives.
 */
export const getConnectionBarStatus = (
  connectionStatus: string,
  isSyncing: boolean,
  idleActive: boolean,
  syncStatus: SyncBarStatus | null,
  syncTrouble: boolean,
): ConnectionBarStatus => {
  if (isSyncing) {
    const label = syncStatus ? syncingLabel(syncStatus) : 'Syncing…';
    return { dotClass: 'bg-orange-500', label, pulse: true };
  }
  if (connectionStatus === 'reconnecting') {
    return { dotClass: 'bg-yellow-500', label: 'Reconnecting…', pulse: true };
  }
  if (connectionStatus === 'disconnected') {
    return { dotClass: 'bg-red-500', label: 'Disconnected', pulse: false };
  }
  // Connected socket, but sync is failing — surface it rather than showing "Live".
  if (syncTrouble) {
    return { dotClass: 'bg-amber-500', label: 'Sync issue', pulse: true };
  }
  // connectionStatus === 'connected'
  return idleActive
    ? { dotClass: 'bg-green-500', label: 'Live', pulse: false }
    : { dotClass: 'bg-green-500', label: 'Connected', pulse: false };
};

/**
 * Visibility gate for the sync-trouble banner. Shows ONLY when the socket is
 * connected but sync is in trouble, re-auth isn't needed (that banner wins), and
 * the user hasn't dismissed it.
 */
export function shouldShowSyncTroubleBanner(args: {
  syncTrouble: boolean;
  connected: boolean;
  needsReauth: boolean;
  dismissed: boolean;
}): boolean {
  return args.syncTrouble && args.connected && !args.needsReauth && !args.dismissed;
}
