/**
 * Names shared by the three places an extension sandbox is put together: the main
 * process, the preload, and the Worker. No imports: the preload and the Worker are
 * bundled from this for a process that has no Node.
 */

/** The scheme the sandbox page and its scripts load from. Handled nowhere else. */
export const SANDBOX_SCHEME = 'sarv-extension-sandbox';

/** One host, in a session per extension, so no extension's origin is another's. */
export const SANDBOX_HOST = 'guest';

/** The origin as a browser spells it. Node's `URL.origin` says 'null' for this scheme. */
export const SANDBOX_ORIGIN = `${SANDBOX_SCHEME}://${SANDBOX_HOST}`;

/** An empty document: nothing runs in the page itself. */
export const SANDBOX_PAGE_URL = `${SANDBOX_ORIGIN}/index.html`;

/** The Worker the extension runs in. */
export const SANDBOX_GUEST_URL = `${SANDBOX_ORIGIN}/guest.js`;

/** Where the extension's own module files are served, by their relative path. */
export const SANDBOX_MODULE_PATH_PREFIX = '/ext/';

/** The one IPC message the page's preload listens for: main handing over the port. */
export const SANDBOX_PORT_CHANNEL = 'extension-sandbox:port';

/** What a served module file calls with its wrapper function. */
export const SANDBOX_DEFINE_GLOBAL = '__sarvDefineModule';

/** The first thing main posts on the port, before the extension protocol starts. */
export interface SandboxInitMessage {
  type: 'sandbox-init';
  /** Every module file the extension ships, relative with `/` separators. */
  files: string[];
}
