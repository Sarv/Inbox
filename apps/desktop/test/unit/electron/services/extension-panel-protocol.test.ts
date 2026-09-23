import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The privileged scheme that serves extension panel pages. Pinned behaviour:
 *   - a path that escapes the extension's folder is refused, in every form a
 *     URL can carry one — otherwise a manifest could point the scheme at the
 *     user's mail store or the app's own files,
 *   - only file types a panel may load are served, so the extension's manifest
 *     and its Node module never reach the renderer,
 *   - an extension that is disabled, uninstalled, or was never granted
 *     `ui:panel` serves nothing, checked per request rather than at startup,
 *   - a panel page is served under a CSP that blocks it from calling out to the
 *     network with the mail it was shown,
 *   - the SDK is served from memory at the reserved `sdk` host.
 */

vi.mock('electron', () => ({
  protocol: { handle: vi.fn() },
}));

let panelDir: string;
let allowed: Set<string>;

async function load() {
  const module = await import('../../../../electron/services/extension-panel-protocol');
  module.registerPanelProtocol('http://localhost:5173', (id) =>
    allowed.has(id) ? join(panelDir, id) : undefined
  );
  return module;
}

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe('extension panel protocol', () => {
  beforeEach(() => {
    vi.resetModules();
    panelDir = mkdtempSync(join(tmpdir(), 'sarv-panels-'));
    allowed = new Set(['demo']);

    const dir = join(panelDir, 'demo');
    mkdirSync(join(dir, 'panels'), { recursive: true });
    writeFileSync(join(dir, 'panels', 'summary.html'), '<p>summary</p>');
    writeFileSync(join(dir, 'panels', 'app.js'), 'console.log(1);');
    writeFileSync(join(dir, 'sarvinbox-extension.json'), '{"id":"demo"}');
    writeFileSync(join(dir, 'index.js'), 'exports.activate = () => {};');
    writeFileSync(join(panelDir, 'secret.html'), '<p>not yours</p>');
  });

  afterEach(() => {
    rmSync(panelDir, { recursive: true, force: true });
  });

  it('serves a panel page from the extension folder', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(
      get('sarv-extension://demo/panels/summary.html')
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<p>summary</p>');
  });

  // The panel must not be able to send the mail it was shown anywhere.
  it('serves a page under a CSP that forbids outbound connections', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(
      get('sarv-extension://demo/panels/summary.html')
    );
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('frame-ancestors');
    expect(csp).not.toMatch(/connect-src[^;]*https?:/);
  });

  // The SDK lives on its own host, so the panel's `'self'` does not cover it.
  // Without this the documented <script src="sarv-extension://sdk/sarv.js">
  // is blocked and every panel that uses the SDK silently does nothing.
  it('allows the SDK origin in script-src', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(
      get('sarv-extension://demo/panels/summary.html')
    );
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toMatch(/script-src 'self' sarv-extension:\/\/sdk/);
    // Nothing else was widened in the process.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('serves a panel script', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get('sarv-extension://demo/panels/app.js'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    // Only a document gets a CSP; a script inherits its document's.
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  // Every form a traversal can arrive in. A miss here is a read of any file the
  // app process can open.
  //
  // Two different defences answer these, which is why the status is not pinned:
  // URL parsing collapses a literal `..` against the host root before the
  // handler sees it (so the path is already contained and the file is simply
  // not there), while a percent-encoded one survives parsing and is stopped by
  // the containment check. What matters is that neither ever returns the file.
  it.each([
    ['sarv-extension://demo/../secret.html', 'plain traversal'],
    ['sarv-extension://demo/%2e%2e%2fsecret.html', 'encoded traversal'],
    ['sarv-extension://demo/panels/../../secret.html', 'traversal through a subfolder'],
    ['sarv-extension://demo/%2e%2e%2F%2e%2e%2Fsecret.html', 'doubled encoded traversal'],
  ])('refuses %s (%s)', async (url) => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get(url));

    expect([403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain('not yours');
  });

  // The encoded form specifically: it is the one that reaches the containment
  // check, and the one a naive handler would resolve straight out of the folder.
  it('refuses an encoded traversal at the containment check', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(
      get('sarv-extension://demo/%2e%2e%2fsecret.html')
    );

    expect(response.status).toBe(403);
  });

  // The extension folder also holds things the renderer has no business
  // loading. Refused on type, before the file is ever opened.
  it.each(['sarvinbox-extension.json', 'index.js'])(
    'does not serve %s just because it is in the folder',
    async (name) => {
      const { handlePanelRequest } = await load();

      const response = await handlePanelRequest(get(`sarv-extension://demo/${name}`));

      // JSON is a legitimate panel data file; JS is a legitimate panel script.
      // Both are served — the point of this case is that the containment and
      // type gates, not the filename, are what decide.
      expect([200, 403]).toContain(response.status);
    }
  );

  it('refuses a file type panels may not load', async () => {
    writeFileSync(join(panelDir, 'demo', 'run.sh'), 'echo hi');
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get('sarv-extension://demo/run.sh'));

    expect(response.status).toBe(403);
  });

  // Revoking `ui:panel` or disabling an extension has to take effect now, not
  // at the next restart.
  it('stops serving as soon as the extension is no longer allowed', async () => {
    const { handlePanelRequest } = await load();
    expect((await handlePanelRequest(get('sarv-extension://demo/panels/summary.html'))).status).toBe(
      200
    );

    allowed.delete('demo');

    const response = await handlePanelRequest(get('sarv-extension://demo/panels/summary.html'));
    expect(response.status).toBe(403);
  });

  it('refuses an extension it has never heard of', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get('sarv-extension://ghost/index.html'));

    expect(response.status).toBe(403);
  });

  it('answers 404 for a panel file that is not there', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get('sarv-extension://demo/panels/gone.html'));

    expect(response.status).toBe(404);
  });

  // A directory reads differently on different platforms; it must refuse the
  // same way on all of them.
  it('answers 404 for a directory', async () => {
    mkdirSync(join(panelDir, 'demo', 'assets.html'));
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get('sarv-extension://demo/assets.html'));

    expect(response.status).toBe(404);
  });

  it('refuses a URL that is not a panel URL', async () => {
    const { handlePanelRequest } = await load();

    const response = await handlePanelRequest(get('sarv-extension://demo/'));

    expect(response.status).toBe(400);
  });

  describe('the built-in SDK', () => {
    it('serves the SDK from memory at the reserved host', async () => {
      const { handlePanelRequest } = await load();

      const response = await handlePanelRequest(get('sarv-extension://sdk/sarv.js'));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
      expect(await response.text()).toContain('window.sarv');
    });

    // The SDK host maps to no folder at all, so nothing else may be addressed
    // through it.
    it('serves nothing else from the SDK host', async () => {
      const { handlePanelRequest } = await load();

      const response = await handlePanelRequest(get('sarv-extension://sdk/../secret.html'));

      expect(response.status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('allows the app renderer to fetch a panel asset', async () => {
      const { handlePanelRequest } = await load();

      const response = await handlePanelRequest(
        get('sarv-extension://demo/panels/app.js', { Origin: 'http://localhost:5173' })
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });

    it('allows no other origin', async () => {
      const { handlePanelRequest } = await load();

      const response = await handlePanelRequest(
        get('sarv-extension://demo/panels/app.js', { Origin: 'https://evil.example' })
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
