/**
 * Files staged for commit get `eslint --fix` before the commit is written.
 *
 * Only ERRORS block a commit — the repo carries ~1600 warnings (mostly
 * `no-explicit-any`), and eslint's default `--max-warnings` of -1 lets those
 * through. Anything auto-fixable (import order above all) is repaired and
 * re-staged by lint-staged with no prompt; only a genuine error stops you.
 *
 * Deliberately NOT running the test suite here: it is ~5800 tests across three
 * packages and would make every commit unbearable. CI is the right place for
 * that. This hook exists for the one class of failure that is both trivially
 * auto-fixable and was reaching CI anyway.
 */
export default {
  '*.{ts,tsx,js,jsx,mjs,cjs}': ['eslint --fix'],
};
