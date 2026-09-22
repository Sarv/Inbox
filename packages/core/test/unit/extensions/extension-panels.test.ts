/**
 * Panel contributions: manifest validation, the panel-only load path, and the
 * addressing/allow-list rules the privileged scheme is built on.
 *
 * What breaks if these fail: an extension could ship a panel whose entry path
 * escapes its own folder, could be served a file type the iframe should never
 * receive, or a UI-only extension could fail to install at all.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadExtension,
  validateManifest,
  MANIFEST_FILENAME,
} from '../../../src/extensions/extension-loader';
import {
  panelAssetContentType,
  panelAssetUrl,
  parsePanelUrl,
  SDK_HOST,
} from '../../../src/extensions/panel-assets';
import type { ExtensionManifest } from '../../../src/extensions/types';

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: 'panel-demo',
    name: 'Panel Demo',
    version: '1.0.0',
    description: 'A panel',
    author: 'Sarv',
    main: 'index.js',
    engines: { sarvinbox: '>=1.0.0' },
    permissions: [],
    ...overrides,
  } as ExtensionManifest;
}

describe('panel manifest validation', () => {
  // A panel whose entry escapes the extension folder would let a manifest
  // point the privileged scheme at any file on disk.
  it.each([
    ['../../../etc/passwd/panel.html', 'parent traversal'],
    ['/etc/passwd/panel.html', 'absolute posix path'],
    ['C:\\Windows\\panel.html', 'windows drive letter'],
    ['\\\\server\\share\\panel.html', 'UNC path'],
    ['nested\\..\\..\\panel.html', 'backslash traversal'],
  ])('rejects an entry that escapes the extension folder (%s)', (entry) => {
    const result = validateManifest(
      manifest({
        permissions: ['ui:panel'],
        contributes: {
          panels: [{ id: 'p', title: 'P', entry, surface: 'sidebar' }],
        },
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('entry');
  });

  // Two panels sharing an id means the app cannot tell which one to open.
  it('rejects duplicate panel ids', () => {
    const result = validateManifest(
      manifest({
        contributes: {
          panels: [
            { id: 'p', title: 'One', entry: 'one.html', surface: 'sidebar' },
            { id: 'p', title: 'Two', entry: 'two.html', surface: 'modal' },
          ],
        },
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/duplicate/i);
  });

  // Only HTML is a page. Pointing a panel at the extension's module would ask
  // the scheme to serve code as a document.
  it('rejects an entry that is not an HTML file', () => {
    const result = validateManifest(
      manifest({
        contributes: {
          panels: [{ id: 'p', title: 'P', entry: 'index.js', surface: 'sidebar' }],
        },
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/html/i);
  });

  it('rejects an unknown surface', () => {
    const result = validateManifest(
      manifest({
        contributes: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          panels: [{ id: 'p', title: 'P', entry: 'p.html', surface: 'inline' as any }],
        },
      })
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/surface/i);
  });

  // A modal is opened by the reader, so there is nothing for autoOpen to mean.
  // Warn rather than fail: the panel still works.
  it('warns that autoOpen does nothing on a modal', () => {
    const result = validateManifest(
      manifest({
        contributes: {
          panels: [
            { id: 'p', title: 'P', entry: 'p.html', surface: 'modal', autoOpen: true },
          ],
        },
      })
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/autoOpen/);
  });

  it('accepts a well-formed panel', () => {
    const result = validateManifest(
      manifest({
        permissions: ['ui:panel'],
        contributes: {
          panels: [
            {
              id: 'summary',
              title: 'Summary',
              entry: 'panels/summary.html',
              surface: 'sidebar',
              icon: 'icons/summary.svg',
              width: 360,
            },
          ],
        },
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // The panel scheme serves the app's own SDK from this host; an extension
  // installed there would be addressed by the same URLs.
  it('refuses the reserved sdk id', () => {
    const result = validateManifest(manifest({ id: SDK_HOST }));

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/reserved/i);
  });

  // The manifest alone cannot tell a no-build extension from a broken one —
  // only the folder can — so this is a warning here and an error in the loader.
  it('warns, but does not fail, when nothing declares where the code is', () => {
    const bare = manifest();
    delete (bare as { main?: string }).main;

    const result = validateManifest(bare);

    expect(result.valid).toBe(true);
    expect(result.warnings.join('\n')).toContain('index.js');
  });
});

describe('loading an extension folder', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sarv-panel-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(dir: string, value: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(value));
  }

  // A UI-only extension has no module at all. Demanding one would mean every
  // panel author ships a stub file that does nothing.
  it('loads a panel-only extension with no entry point', async () => {
    const dir = join(root, 'ui-only');
    writeManifest(dir, {
      id: 'ui-only',
      name: 'UI Only',
      version: '1.0.0',
      description: 'Panels only',
      author: 'Sarv',
      engines: { sarvinbox: '>=1.0.0' },
      permissions: ['ui:panel'],
      contributes: {
        panels: [{ id: 'main', title: 'Main', entry: 'index.html', surface: 'sidebar' }],
      },
    });
    writeFileSync(join(dir, 'index.html'), '<p>hi</p>');

    const loaded = await loadExtension(dir);

    expect(loaded.entryPoint).toBeUndefined();
    expect(loaded.manifest.contributes?.panels?.[0].id).toBe('main');
  });

  // No-build authoring: a folder with a manifest and an index.js is a complete
  // extension, with no `main` to declare and no bundler to run.
  it('finds index.js when the manifest declares no main', async () => {
    const dir = join(root, 'implicit');
    writeManifest(dir, {
      id: 'implicit',
      name: 'Implicit',
      version: '1.0.0',
      description: 'No main',
      author: 'Sarv',
      engines: { sarvinbox: '>=1.0.0' },
      permissions: [],
    });
    writeFileSync(join(dir, 'index.js'), 'exports.activate = () => {};');

    const loaded = await loadExtension(dir);

    expect(loaded.entryPoint).toBe(join(dir, 'index.js'));
  });

  // Still an error with neither: activating nothing, silently, would leave the
  // user with an installed extension that never does anything.
  it('fails when there is neither a module nor a panel', async () => {
    const dir = join(root, 'empty');
    writeManifest(dir, {
      id: 'empty',
      name: 'Empty',
      version: '1.0.0',
      description: 'Nothing',
      author: 'Sarv',
      engines: { sarvinbox: '>=1.0.0' },
      permissions: [],
    });

    await expect(loadExtension(dir)).rejects.toThrow(/Entry point not found/);
  });
});

describe('panel asset addressing', () => {
  it('parses a panel URL', () => {
    expect(parsePanelUrl('sarv-extension://panel-demo/panels/summary.html')).toEqual({
      host: 'panel-demo',
      assetPath: 'panels/summary.html',
    });
  });

  // An encoded traversal must reach the containment check as a real `..`, not
  // as literal `%2e%2e` that resolves to a harmless-looking filename.
  it('decodes percent escapes before anyone resolves the path', () => {
    expect(parsePanelUrl('sarv-extension://panel-demo/%2e%2e%2fsecret.html')).toEqual({
      host: 'panel-demo',
      assetPath: '../secret.html',
    });
  });

  it.each([
    ['file:///etc/passwd', 'a different scheme'],
    ['sarv-extension://panel-demo/', 'no path'],
    ['sarv-extension://panel-demo/%zz', 'a malformed escape'],
    ['not a url', 'not a URL at all'],
  ])('refuses to parse %s (%s)', (raw) => {
    expect(parsePanelUrl(raw)).toBeUndefined();
  });

  it('round-trips a path with a space through panelAssetUrl', () => {
    const url = panelAssetUrl('panel-demo', './my panels/a b.html');

    expect(url).toBe('sarv-extension://panel-demo/my%20panels/a%20b.html');
    expect(parsePanelUrl(url)?.assetPath).toBe('my panels/a b.html');
  });
});

describe('panel asset content types', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['app.mjs', 'text/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['icon.svg', 'image/svg+xml'],
    ['font.woff2', 'font/woff2'],
  ])('serves %s as %s', (name, expected) => {
    expect(panelAssetContentType(name)).toBe(expected);
  });

  // Refusing outright, not falling back to octet-stream: an extension folder
  // also holds its manifest and its Node module, and none of that belongs in
  // a page the renderer loads.
  it.each(['index.node', 'run.sh', 'README', 'notes.txt', 'archive.zip'])(
    'refuses to serve %s',
    (name) => {
      expect(panelAssetContentType(name)).toBeUndefined();
    }
  );

  it('matches the extension case-insensitively', () => {
    expect(panelAssetContentType('PANEL.HTML')).toBe('text/html; charset=utf-8');
  });

  it('refuses a dotfile with no extension', () => {
    expect(panelAssetContentType('.env')).toBeUndefined();
  });
});
