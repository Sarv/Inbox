/*
 * The Electron fuses every packaged Sarv Inbox build must carry, and the pure
 * helpers that check a build against them.
 *
 * Fuses are bits compiled into the Electron binary that switch off runtime
 * features before any app code runs. Left at their defaults, a local process
 * could run arbitrary code AS the signed app — `ELECTRON_RUN_AS_NODE=1`,
 * `NODE_OPTIONS=--require evil.js`, or `--inspect` — and the macOS Keychain
 * trusts the signed app, so that code could read the "Sarv Inbox Safe Storage"
 * item and decrypt the mail database key, sign-in tokens and passwords without
 * a prompt. A modified app.asar would also go unnoticed (CASA M-2).
 *
 * ONE list, read by three places so they can't drift:
 *   - apps/desktop/package.json `build.electronFuses` (electron-builder flips
 *     them) — pinned equal to this by apps/desktop/test/unit/scripts/electron-fuses.test.ts,
 *   - scripts/verify-fuses.mjs, which reads them back out of every packaged
 *     binary in the release workflow,
 *   - that test.
 */

/**
 * Fuse name (as `@electron/fuses` FuseV1Options spells it) → required state.
 *
 * GrantFileProtocolExtraPrivileges stays ON deliberately: the production
 * window loads dist/index.html over file:// (electron/main.ts), which needs
 * those privileges. Turning it off first needs the UI served from a custom
 * protocol. LoadBrowserProcessSpecificV8Snapshot is unused, so off.
 */
export const EXPECTED_FUSES = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
});

/**
 * electron-builder's `electronFuses` keys for each fuse (camelCase, no "V1").
 * Only fuses we change from Electron's default are written to the config.
 */
export const BUILDER_KEYS = Object.freeze({
  RunAsNode: 'runAsNode',
  EnableCookieEncryption: 'enableCookieEncryption',
  EnableNodeOptionsEnvironmentVariable: 'enableNodeOptionsEnvironmentVariable',
  EnableNodeCliInspectArguments: 'enableNodeCliInspectArguments',
  EnableEmbeddedAsarIntegrityValidation: 'enableEmbeddedAsarIntegrityValidation',
  OnlyLoadAppFromAsar: 'onlyLoadAppFromAsar',
  LoadBrowserProcessSpecificV8Snapshot: 'loadBrowserProcessSpecificV8Snapshot',
  GrantFileProtocolExtraPrivileges: 'grantFileProtocolExtraPrivileges',
});

/**
 * The marker `@electron/fuses` searches for; the fuse wire follows it. Copied
 * because the library doesn't export it — electron-fuses.test.ts pins it equal
 * to the installed library's constant.
 */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** ASCII state bytes in a fuse wire. */
const ENABLED = 0x31; // '1'
const DISABLED = 0x30; // '0'
const REMOVED = 0x72; // 'r'

/**
 * The file that carries the fuse wire. On macOS that is the Electron Framework
 * inside the `.app`, not the MacOS/ launcher; elsewhere the executable itself.
 * (Same rule as @electron/fuses, which doesn't export it.)
 *
 * @param {string} target A `.app`, a path inside one, or an executable.
 * @returns {string}
 */
export function fuseFilePath(target) {
  const at = target.indexOf('.app/');
  const app = target.endsWith('.app') ? target : at >= 0 ? target.slice(0, at + '.app'.length) : null;
  if (!app) return target;
  return `${app}/Contents/Frameworks/Electron Framework.framework/Electron Framework`;
}

/**
 * Every fuse wire in a binary. A universal macOS build carries TWO — one per
 * CPU slice — and `@electron/fuses` getCurrentFuseWire reads only the first,
 * so a slice electron-builder failed to flip would pass unnoticed. This reads
 * them all.
 *
 * @param {Buffer} binary
 * @returns {{ offset: number, version: number, states: number[] }[]}
 */
export function readFuseWires(binary) {
  const sentinel = Buffer.from(FUSE_SENTINEL, 'ascii');
  /** @type {{ offset: number, version: number, states: number[] }[]} */
  const wires = [];
  let at = binary.indexOf(sentinel);
  while (at >= 0) {
    const start = at + sentinel.length;
    const version = binary[start];
    const length = binary[start + 1] ?? 0;
    const states = [...binary.subarray(start + 2, start + 2 + length)];
    wires.push({ offset: at, version, states });
    at = binary.indexOf(sentinel, start);
  }
  return wires;
}

/**
 * Compare one fuse wire with {@link EXPECTED_FUSES}.
 *
 * Pure. `states[id]` is the ASCII state byte of fuse `id` ('1' enabled, '0'
 * disabled, 'r' removed); `ids` maps the fuse name to its FuseV1Options id. A
 * fuse that is missing, removed, unreadable or in the wrong state is a
 * problem: verifying nothing is how a check like this ships broken.
 *
 * @param {number[]} states
 * @param {Record<string, number>} ids
 * @returns {string[]} One message per wrong fuse; empty when all are right.
 */
export function fuseProblems(states, ids) {
  /** @type {string[]} */
  const problems = [];
  for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
    const id = ids[name];
    if (id === undefined) {
      problems.push(`${name}: unknown to the installed @electron/fuses`);
      continue;
    }
    const state = states[id];
    if (state === undefined) problems.push(`${name}: not present in this binary`);
    else if (state === REMOVED) problems.push(`${name}: removed from this binary`);
    else if (state !== ENABLED && state !== DISABLED) problems.push(`${name}: unreadable state ${state}`);
    else if ((state === ENABLED) !== expected) problems.push(`${name}: is ${state === ENABLED ? 'ON' : 'OFF'}, must be ${expected ? 'ON' : 'OFF'}`);
  }
  return problems;
}
