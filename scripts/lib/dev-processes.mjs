/*
 * Patterns that match a stale dev process belonging to THIS checkout.
 *
 * scripts/dev.sh restarts the app, so it first has to kill whatever the last run
 * left behind. It used to do that with two hand-written patterns:
 *
 *     pkill -f "electron.*sarvinbox"
 *     pkill -f "vite.*desktop"
 *
 * Neither ever matched anything. `electron.*sarvinbox` requires "electron" to
 * appear BEFORE "sarvinbox", but the real command line is
 * `…/sarvinbox/node_modules/electron/…` — the other way round. And the vite
 * process runs as `node …/node_modules/.bin/vite` with no "desktop" anywhere in
 * its argv; only its working directory is apps/desktop, and `pkill -f` matches
 * argv, not cwd. So every restart silently left the previous Electron and vite
 * alive: port 5173 already taken, two instances writing the same SQLite file,
 * and a mail database open twice.
 *
 * Matching on the checkout path fixes both, and scopes the kill correctly as a
 * bonus — a second checkout of this repo, or an unrelated Electron app, is left
 * alone. That matters more now that the repo can live at any path: the old
 * patterns were doomed the moment the directory stopped being called
 * "sarvinbox".
 *
 * This lives in a module rather than inline in the shell script so it can be
 * unit-tested against real command lines. The bug survived for as long as it did
 * precisely because a bash string had no test.
 */

/** Escape a string for safe use inside a POSIX extended regular expression. */
export function escapeEre(literal) {
  // pkill -f takes an ERE. A checkout path can legitimately contain characters
  // that are ERE metacharacters — "." in a directory name, "+" in a branch-named
  // worktree, and on macOS the parentheses in "Projects (old)" style names.
  // Unescaped, "." is the dangerous one: it matches any character, widening the
  // pattern to paths that merely look alike.
  //
  // Only genuine ERE metacharacters are escaped. "/" and "-" are NOT among them
  // outside a bracket expression, and `\/` is undefined behaviour in POSIX ERE —
  // escaping them would make the pattern less portable, not safer.
  return literal.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
}

/**
 * ERE patterns for the dev processes started from `repoRoot`.
 *
 * Anchored on the checkout's own node_modules path, which appears in the argv of
 * both the Electron binary and the vite launcher.
 *
 * @param {string} repoRoot absolute path to the repository root, no trailing slash
 * @returns {string[]} patterns to hand to `pkill -f`, one per process family
 */
export function stalePatterns(repoRoot) {
  const root = escapeEre(repoRoot.replace(/[/\\]+$/, ''));
  return [
    // Electron: the launcher and every helper (GPU, renderer, utility) carry the
    // full path to the binary inside this checkout.
    `${root}/node_modules/electron/`,
    // Vite: `node <root>/node_modules/.bin/vite`, plus the esbuild service it
    // spawns from the same tree.
    `${root}/node_modules/(\\.bin/vite|vite/)`,
  ];
}

// CLI: print one pattern per line for the shell script to consume.
// `node scripts/lib/dev-processes.mjs /path/to/repo`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: node scripts/lib/dev-processes.mjs <repo-root>');
    process.exit(1);
  }
  console.log(stalePatterns(root).join('\n'));
}
