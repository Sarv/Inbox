import { describe, expect, it } from 'vitest';

import {
  BROWSER_SAFE_BUILTINS,
  browserSafeBuiltinsPlugin,
  resolveBrowserSafeBuiltin,
  wantsEmptyBuiltin,
} from '../../../vite/browser-safe-builtins';

// Regression: the renderer is a sandboxed browser with no `require`, so
// vite-plugin-electron-renderer's Node-builtin shim can only throw
// "ReferenceError: require is not defined" at module-evaluation time — a white
// window on first paint, and nothing in app.log. postcss (the dark-mode CSS
// rewrite) declares those builtins optional and guards every use, so it gets the
// empty module every other bundler gives it. These pin BOTH halves: postcss is
// routed to the empty module, and nothing else is — a Node-only dependency has
// to keep failing loudly instead of silently receiving an empty object.

describe('wantsEmptyBuiltin — who gets the empty module', () => {
  it('routes postcss, in a flat node_modules layout', () => {
    expect(wantsEmptyBuiltin('/repo/node_modules/postcss/lib/input.js')).toBe(true);
  });

  it("routes postcss under pnpm's nested layout", () => {
    const id = '/repo/node_modules/.pnpm/postcss@8.5.28/node_modules/postcss/lib/previous-map.js';
    expect(wantsEmptyBuiltin(id)).toBe(true);
  });

  // Regression: the dev server appends `?v=<hash>` to every optimized-dep id.
  // Miss that and dev keeps the throwing shim while the build works.
  it("routes postcss with the dev server's version query", () => {
    expect(wantsEmptyBuiltin('/repo/node_modules/postcss/lib/input.js?v=b45f2df0')).toBe(true);
  });

  it('declines a package that only LOOKS like postcss', () => {
    expect(wantsEmptyBuiltin('/repo/node_modules/postcss-value-parser/lib/index.js')).toBe(false);
  });

  // Regression: this is the loud-failure half. An app file that imports `fs`
  // must not silently get an empty object back.
  it('declines renderer source files', () => {
    expect(wantsEmptyBuiltin('/repo/apps/desktop/src/utils/email-dark-mode.ts')).toBe(false);
  });

  it('declines a Node-only dependency', () => {
    expect(wantsEmptyBuiltin('/repo/node_modules/mailparser/lib/mail-parser.js')).toBe(false);
  });

  it('declines an unknown importer', () => {
    expect(wantsEmptyBuiltin(undefined)).toBe(false);
  });
});

describe('BROWSER_SAFE_BUILTINS — which specifiers are intercepted', () => {
  // Regression: postcss requires all three, bare and node:-prefixed resolution
  // both reach this alias.
  it.each(['fs', 'path', 'url', 'node:fs', 'node:path', 'node:url'])('matches %s', (specifier) => {
    expect(BROWSER_SAFE_BUILTINS.test(specifier)).toBe(true);
  });

  // Regression: kept deliberately narrow. Anything else keeps the Electron
  // plugin's shim, which fails loudly — the right outcome for a module no
  // package has declared browser-optional.
  it.each(['stream', 'dns', 'dns/promises', 'child_process', 'path/posix', 'electron'])(
    'leaves %s alone',
    (specifier) => {
      expect(BROWSER_SAFE_BUILTINS.test(specifier)).toBe(false);
    },
  );
});

describe('resolveBrowserSafeBuiltin — the resolution itself', () => {
  const DESKTOP = '/repo/apps/desktop';
  const EMPTY = '/repo/apps/desktop/vite/empty-node-builtin.mjs';

  it('resolves a listed importer to the empty module', () => {
    expect(resolveBrowserSafeBuiltin('path', '/repo/node_modules/postcss/lib/input.js', DESKTOP)).toBe(EMPTY);
  });

  // Regression: returning anything but null here would hand the empty module to
  // every importer, which is exactly the silent failure this file argues against.
  it('returns null for everyone else, so normal resolution continues', () => {
    expect(resolveBrowserSafeBuiltin('path', '/repo/apps/desktop/src/main.tsx', DESKTOP)).toBeNull();
  });

  // Regression: we sit in front of EVERY resolve, so a specifier we have no
  // opinion about must fall straight through rather than be swallowed.
  it('returns null for a specifier that is not a browser-safe builtin', () => {
    expect(resolveBrowserSafeBuiltin('stream', '/repo/node_modules/postcss/lib/input.js', DESKTOP)).toBeNull();
    expect(resolveBrowserSafeBuiltin('./lib/parse.js', '/repo/node_modules/postcss/lib/input.js', DESKTOP)).toBeNull();
  });
});

describe('browserSafeBuiltinsPlugin — the hook rank that makes it work', () => {
  const plugin = browserSafeBuiltinsPlugin('/repo/apps/desktop');

  // Regression: THE bug of vite-plugin-electron-renderer 1.0. It resolves Node
  // builtins in a resolveId hook declared order:'pre', which sorts ahead of
  // Vite's alias plugin entirely — the alias entry this guard used to be was
  // never consulted, postcss got the require() shim, and the window went white.
  // Only a 'pre' hook can outrank a 'pre' hook.
  it("registers resolveId as a 'pre' hook in the 'pre' enforce group", () => {
    expect(plugin.enforce).toBe('pre');
    expect(typeof plugin.resolveId).toBe('object');
    expect((plugin.resolveId as { order?: string }).order).toBe('pre');
  });

  it('routes postcss through the hook handler', () => {
    const handler = (plugin.resolveId as { handler: (s: string, i?: string) => string | null }).handler;
    expect(handler.call(null, 'path', '/repo/node_modules/postcss/lib/input.js')).toBe(
      '/repo/apps/desktop/vite/empty-node-builtin.mjs',
    );
    expect(handler.call(null, 'path', '/repo/apps/desktop/src/main.tsx')).toBeNull();
  });
});
