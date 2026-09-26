/*
 * The command line of scripts/native-abi.mjs, read without guessing.
 *
 * That script rebuilds better-sqlite3, so a command line it misreads is not a
 * harmless typo: it compiles the addon for an ABI nobody asked for. It used to
 * know one flag (--force), skip every other one and default the runtime to
 * `node`, so the natural first try, `node scripts/native-abi.mjs --help`,
 * REBUILT the addon for Node. On 2026-09-24 that exact command, piped into
 * `head -3`, was then killed by the closed pipe after node-gyp had already
 * deleted build/, which left no addon at all.
 *
 * Node is also the dangerous direction to guess in. The desktop app cannot load
 * a Node-ABI addon, and because every core-DB read answers an unloadable
 * database with an empty result, it boots as an app with no accounts: the
 * reading that made the 2026-09-09 startup sweep delete two live mailbox DBs
 * (see CLAUDE.md).
 *
 * So nothing here is inferred. The runtime must be named, exactly once, and an
 * argument this parser does not know is an error rather than something to skip.
 * Every caller (the package `test*` / `dev*` scripts, scripts/dev.sh) already
 * names the runtime.
 *
 * Kept pure and apart from the script so it can be tested without running it:
 * called wrongly, the script is the thing that breaks the addon.
 */

const RUNTIMES = ['node', 'electron'];

/** Printed for --help, and after every command line that is refused. */
export const USAGE = [
  'Usage: node scripts/native-abi.mjs <node|electron> [--force]',
  '',
  "Rebuild better-sqlite3 for one runtime's ABI, unless it already reports it.",
  'Every package test* script runs this for node and every dev script for',
  'electron, so you should not need to run it yourself.',
  '',
  '  node        plain Node, which the test suites run in',
  '  electron    Electron, which the desktop app runs in',
  '  --force     rebuild even when the addon already reports that ABI',
  '  -h, --help  print this and exit, without touching the addon',
  '',
  'Left on the node ABI, the desktop app cannot open any database. Before',
  'starting the app, run: node scripts/native-abi.mjs electron',
].join('\n');

/**
 * Read the script's arguments, i.e. `process.argv.slice(2)`.
 *
 * Help is checked first and wins over everything else on the line, including
 * arguments that would otherwise be refused: whoever typed it wants to know
 * what the command does, not to have it done.
 *
 * @param {readonly string[]} argv
 * @returns {{kind: 'run', runtime: 'node' | 'electron', force: boolean}
 *   | {kind: 'help'}
 *   | {kind: 'error', message: string}}
 */
export function parseNativeAbiArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  let force = false;
  const named = [];
  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
    } else if (arg.startsWith('-')) {
      // `--` and a lone `-` included: neither means anything to this script,
      // and a runtime never starts with a dash.
      return { kind: 'error', message: `unknown option "${arg}"` };
    } else {
      named.push(arg);
    }
  }

  if (named.length === 0) {
    return { kind: 'error', message: 'missing runtime — name "node" or "electron"' };
  }
  if (named.length > 1) {
    const got = named.map((arg) => `"${arg}"`).join(', ');
    return { kind: 'error', message: `expected one runtime, got ${named.length}: ${got}` };
  }
  // Case-insensitive, as it always was: `Electron` names exactly one runtime.
  const runtime = named[0].toLowerCase();
  if (!RUNTIMES.includes(runtime)) {
    return { kind: 'error', message: `unknown runtime "${named[0]}" — use "node" or "electron"` };
  }
  return { kind: 'run', runtime, force };
}
