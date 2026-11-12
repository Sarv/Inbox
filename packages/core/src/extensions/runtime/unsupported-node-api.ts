/**
 * Telling an extension's user that it needs something the sandbox does not allow.
 *
 * Extensions used to run as full Node code, so a published one may `require('fs')`,
 * read `process.env` or call `fetch`. Inside the sandbox none of those work. The bare
 * JavaScript error ("process is not defined") reaches nobody who can act on it, and a
 * workflow failing quietly on every message looks like an extension that just stopped
 * working. So each form is turned into one sentence naming what is unsupported, which
 * main shows in Settings and on a card.
 *
 * Pure, with no imports: this runs inside the sandbox as well as in main.
 */

/** Thrown by the sandbox's `require` for a module it refuses to provide. */
export class UnsupportedNodeApiError extends Error {
  readonly api: string;

  constructor(api: string) {
    super(unsupportedNodeApiMessage(api));
    this.name = 'UnsupportedNodeApiError';
    this.api = api;
  }
}

/** What the sandbox refuses that is not a Node API: said in those terms instead. */
const SANDBOX_REFUSALS: Record<string, string> = {
  network:
    'This extension tried to reach the network by itself, which extensions can no longer do: ' +
    'they now go through the network permission. Check for an update from its author.',
  'remote-code':
    'This extension tried to load code from outside its own files, which extensions can no ' +
    'longer do. Check for an update from its author.',
  eval:
    'This extension builds scripts from strings (eval or new Function), which extensions can ' +
    'no longer do. Check for an update from its author.',
};

/** The sentence the user reads. Names the API, and what to do about it. */
export function unsupportedNodeApiMessage(api: string): string {
  const refusal = SANDBOX_REFUSALS[api];
  if (refusal) return refusal;
  return (
    `This extension uses Node's "${api}", which extensions can no longer use: they now run ` +
    'in a sandbox with no access to your files or the network of their own. ' +
    'Check for an update from its author.'
  );
}

/**
 * The module names Node provides, plus the two Electron adds.
 *
 * Written out because this runs where `module.builtinModules` does not exist. A
 * test holds the list against the real one, so a new Node release cannot leave
 * a builtin reported as an ordinary missing module.
 */
const NODE_BUILTIN_MODULES = new Set([
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform', '_stream_wrap',
  '_stream_writable', '_tls_common', '_tls_wrap', 'assert', 'async_hooks', 'buffer', 'child_process',
  'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'electron', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'original-fs',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/**
 * The Node module a specifier names, or null when it names none.
 *
 * `node:fs`, `fs` and `fs/promises` all answer `fs`; `node:` always counts,
 * since nothing else can own that prefix.
 */
export function nodeBuiltinNamed(specifier: string): string | null {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  const root = bare.split('/')[0];
  if (specifier.startsWith('node:') || NODE_BUILTIN_MODULES.has(root)) return root;
  return null;
}

/** Globals Node provides and a Web Worker does not. */
const NODE_GLOBALS = new Set([
  'process',
  'Buffer',
  'global',
  'setImmediate',
  'clearImmediate',
]);

/**
 * Node idioms on things a Worker does have, where the only symptom is a TypeError:
 * `setTimeout(...).unref()` on what is a number here, and Node's `crypto` methods on the
 * Worker's own `crypto`. The text is V8's, so a match means the call really was made.
 */
const NODE_METHOD_ERRORS: readonly (readonly [suffix: string, api: string])[] = [
  ['.unref is not a function', 'timer.unref'],
  ['.ref is not a function', 'timer.unref'],
  ['.hasRef is not a function', 'timer.unref'],
  ['crypto.createHash is not a function', 'crypto'],
  ['crypto.createHmac is not a function', 'crypto'],
  ['crypto.randomBytes is not a function', 'crypto'],
];

/**
 * Whether a name reported from a sandbox really is a Node API.
 *
 * The extension can post whatever it likes on its port, and this name goes into a
 * sentence on a card. Only names from these lists are ever shown, so that sentence
 * cannot be made to carry a message of the extension's own.
 */
export function isKnownNodeApi(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    (NODE_BUILTIN_MODULES.has(name) ||
      NODE_GLOBALS.has(name) ||
      Object.prototype.hasOwnProperty.call(SANDBOX_REFUSALS, name) ||
      NODE_METHOD_ERRORS.some(([, api]) => api === name))
  );
}

/**
 * What a line on the sandbox's console says was refused, or null if it is not a refusal.
 *
 * A blocked `fetch` throws a bare "Failed to fetch", and an extension's own `catch`
 * usually swallows that, so the console line Chromium writes for the policy is the only
 * sign left. An extension can write this line itself. All that buys it is a card, in the
 * app's words, saying it did what it just claimed to do.
 */
export function refusalInConsoleLine(line: string): 'network' | 'remote-code' | null {
  if (!line.includes('Content Security Policy')) return null;
  if (line.includes('connect-src') || line.includes('Refused to connect')) return 'network';
  if (line.includes('font-src') || line.includes('img-src') || line.includes('media-src')) return 'network';
  if (line.includes('script-src') || line.includes('worker-src')) return 'remote-code';
  return null;
}

/**
 * The Node API behind an error, or null when it has nothing to do with one.
 *
 * Read by name rather than `instanceof`: the error may have crossed a realm.
 * A `ReferenceError` whose text does not parse just falls through as an ordinary
 * error, which is the safe direction: the extension still reports its failure.
 */
export function nodeApiBehindError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { name, message, api } = error as { name?: unknown; message?: unknown; api?: unknown };
  if (name === 'UnsupportedNodeApiError' && typeof api === 'string') return api;
  // The policy's refusal of `eval` and `new Function`, and of nothing else.
  if (name === 'EvalError') return 'eval';
  if (typeof message !== 'string') return null;
  if (name === 'TypeError') {
    return NODE_METHOD_ERRORS.find(([suffix]) => message.endsWith(suffix))?.[1] ?? null;
  }
  if (name !== 'ReferenceError') return null;
  const notDefined = ' is not defined';
  if (!message.endsWith(notDefined)) return null;
  const identifier = message.slice(0, -notDefined.length);
  return NODE_GLOBALS.has(identifier) ? identifier : null;
}
