import type { IIMAPClient } from '../types/imap';

/**
 * Run `run()` with `folderPath` selected for its whole duration.
 *
 * The single entry point every select-then-work sequence should use. On a real
 * connection it delegates to `IIMAPClient.withFolder`, which holds that socket's
 * mailbox lock so no concurrent SELECT can land mid-sequence (see
 * `ImapFlowClient.withFolder`). A client that doesn't implement the optional
 * method degrades to the old select-then-work behaviour rather than throwing.
 *
 * `opts.select === false` takes the lock WITHOUT selecting, for a section that
 * performs its own specialised SELECT (e.g. the QRESYNC resynchronising select).
 */
export async function withFolderSelected<T>(
  client: IIMAPClient,
  folderPath: string,
  run: () => Promise<T>,
  opts?: { select?: boolean },
): Promise<T> {
  if (typeof client.withFolder === 'function') {
    return client.withFolder(folderPath, run, opts);
  }
  if (opts?.select !== false) await client.selectFolder(folderPath);
  return run();
}
