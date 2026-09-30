/**
 * The OpenPGP preferences in the settings blob, read ONE way by both readers:
 * the main process, which decides what may leave the machine, and the
 * Encryption settings tab, which shows the user what will. Zero imports, so the
 * renderer deep-imports it without loading openpgp.
 *
 *   pgpWkdLookup        ask a recipient's OWN mail domain for their key (Web
 *                       Key Directory). That domain already receives the mail,
 *                       so it learns nothing new. On by default.
 *   pgpKeyserverLookup  ask keys.openpgp.org — a third party, which then
 *                       learns who the user is writing to. OFF by default and
 *                       only the boolean true turns it on.
 *   pgpAutoEncrypt      encrypt without being asked when every recipient has a
 *                       key. On by default.
 */
export interface PgpPrefs {
  wkdLookup: boolean;
  keyserverLookup: boolean;
  autoEncrypt: boolean;
}

export const DEFAULT_PGP_PREFS: PgpPrefs = { wkdLookup: true, keyserverLookup: false, autoEncrypt: true };

/**
 * Read the prefs from a parsed settings blob. Anything that is not the literal
 * boolean reads as the default — except the keyserver, whose default is the
 * one that asks nobody.
 */
export function readPgpPrefs(blob: unknown): PgpPrefs {
  const record = blob && typeof blob === 'object' ? (blob as Record<string, unknown>) : {};
  const flag = (key: string, fallback: boolean) => (typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback);
  return {
    wkdLookup: flag('pgpWkdLookup', DEFAULT_PGP_PREFS.wkdLookup),
    keyserverLookup: record.pgpKeyserverLookup === true,
    autoEncrypt: flag('pgpAutoEncrypt', DEFAULT_PGP_PREFS.autoEncrypt),
  };
}
