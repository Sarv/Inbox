// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionManager } from '../../../../src/components/ExtensionManager';
import { act, render, type Mounted } from '../../../helpers/render';

/**
 * Telling someone what they are running is out of date, on the tab they look at.
 *
 * What breaks if this file goes red: an extension keeps running an old build
 * with nothing on screen to say so. The Browse tab already flags it, but nobody
 * opens a catalogue to check on something they have already installed — the
 * Installed tab is the only place the message reaches them.
 *
 * The other half is consent. An update is allowed to ask for more than the
 * version it replaces, and a one-click "Update all" that quietly granted the
 * difference would be the cleanest way in the app to acquire a permission
 * nobody agreed to. So anything asking for something new is held back from the
 * bulk action and sent through the dialog instead.
 */

const installed = (over: Record<string, unknown> = {}) => ({
  id: 'otp-code',
  source: 'marketplace' as const,
  path: '/ext/otp',
  version: '1.0.0',
  installedAt: 1_800_000_000_000,
  enabled: true,
  grantedPermissions: ['email:read'],
  settings: {},
  ...over,
});

const info = (id: string) => ({
  manifest: {
    id,
    name: id,
    version: '1.0.0',
    description: 'An extension',
    author: 'Sarv',
    permissions: ['email:read'],
  },
  state: 'active',
  enabled: true,
  path: `/ext/${id}`,
  workflowIds: [],
});

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'otp-code',
  name: 'One-Time Passcodes',
  version: '1.1.0',
  description: 'Surfaces verification codes',
  author: 'Sarv',
  keywords: [],
  permissions: ['email:read'],
  size: 2048,
  stats: { downloads: 10 },
  sourceUrl: 'https://example.test/otp',
  state: 'update-available' as const,
  installedVersion: '1.0.0',
  ...over,
});

type Api = ReturnType<typeof buildApi>;

let api: Api;
let mounted: Mounted | null = null;
/** Extensions being installed right now, so an overlapping pair is visible. */
let inFlight = 0;
let maxInFlight = 0;

const buildApi = (
  extensions: ReturnType<typeof installed>[],
  items: ReturnType<typeof offer>[]
) => ({
  list: vi.fn(async () => ({ success: true, data: extensions })),
  getInfo: vi.fn(async (id: string) => ({ success: true, data: info(id) })),
  enable: vi.fn(async () => ({ success: true })),
  disable: vi.fn(async () => ({ success: true })),
  uninstall: vi.fn(async () => ({ success: true })),
  selectAndInstall: vi.fn(async () => ({ success: true })),
  browse: vi.fn(async () => ({
    success: true,
    data: {
      items,
      registries: [
        { url: 'r', source: null, stars: 0, generatedAt: null, ok: true, fromCache: false },
      ],
    },
  })),
  registryDetail: vi.fn(async () => ({ success: true, data: items[0] })),
  // Typed with the id it is called with so a test can fail one extension and
  // not another, and instrumented so an overlapping pair of installs is visible.
  installFromRegistry: vi.fn(
    async (_id: string): Promise<{ success: boolean; error?: string }> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { success: true };
    }
  ),
});

const install = (extensions: ReturnType<typeof installed>[], items: ReturnType<typeof offer>[]) => {
  api = buildApi(extensions, items);
  (window as unknown as Record<string, unknown>).electronAPI = { extensions: api };
};

/** Mount and let the list, the per-extension info and the catalogue all settle. */
const mount = async () => {
  const view = render(<ExtensionManager />);
  await settle();
  mounted = view;
  return view;
};

const settle = async () => {
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
};

const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
};

const button = (view: Mounted, text: string) =>
  view.all('button').find((node) => node.textContent?.includes(text));

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).electronAPI;
});

describe('ExtensionManager updates', () => {
  // Regression: the Installed tab showed a version number and nothing else, so
  // a fixed bug sat unshipped on a machine whose owner had no way to know.
  it('says on the installed row that a newer version is waiting', async () => {
    install([installed()], [offer()]);
    const view = await mount();

    expect(view.container.textContent).toContain('v1.1.0 available');
    expect(view.container.textContent).toContain('An update is available');
    expect(button(view, 'Update all (1)')).toBeTruthy();
  });

  // Regression: an up-to-date extension drew an Update button that reinstalled
  // the version already running.
  it('says nothing when the catalogue is offering what is already installed', async () => {
    install([installed()], [offer({ state: 'installed', version: '1.0.0' })]);
    const view = await mount();

    expect(view.container.textContent).not.toContain('available');
    expect(button(view, 'Update all')).toBeUndefined();
  });

  // Regression: the update installed with an empty permission list, which
  // grants exactly that and left the extension unable to read anything.
  it('hands the update the whole permission list the new version asks for', async () => {
    install(
      [installed({ grantedPermissions: ['email:read', 'ui:notify'] })],
      [offer({ permissions: ['email:read', 'ui:notify'] })]
    );
    const view = await mount();

    await click(view.byLabel('Update otp-code to version 1.1.0'));

    expect(api.installFromRegistry).toHaveBeenCalledWith('otp-code', ['email:read', 'ui:notify']);
    // The list is re-read so the row stops offering an update it just applied.
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  // Regression: Update all fired every install at once. Each one deletes and
  // rewrites an install folder and re-activates the extension in the host, so
  // two at a time race over the same registry file.
  it('applies several updates one at a time', async () => {
    install(
      [installed(), installed({ id: 'vip-scoring', path: '/ext/vip' })],
      [offer(), offer({ id: 'vip-scoring', version: '2.0.0' })]
    );
    const view = await mount();

    await click(button(view, 'Update all (2)'));

    expect(api.installFromRegistry.mock.calls.map((call) => call[0])).toEqual([
      'otp-code',
      'vip-scoring',
    ]);
    expect(maxInFlight).toBe(1);
  });

  // Regression: an update that gained a permission was installed by the bulk
  // action without asking. That is the one thing the consent dialog exists for.
  it('holds back an update that asks for something new and sends it for review', async () => {
    install([installed()], [offer({ permissions: ['email:read', 'email:send'] })]);
    const view = await mount();

    expect(view.container.textContent).toContain('1 of them ask for something new');
    expect(button(view, 'Update all')).toBeUndefined();

    await click(view.byLabel('Update otp-code to version 1.1.0'));

    expect(api.installFromRegistry).not.toHaveBeenCalled();
    // Handing it to Browse is what puts the checksum and the permission diff in
    // front of the reader before anything is downloaded.
    expect(api.registryDetail).toHaveBeenCalledWith('otp-code');
  });

  // Regression: one failure in the middle of Update all was reported as the
  // whole run failing, and the extensions after it were never attempted.
  it('reports a failed update and still applies the rest', async () => {
    install(
      [installed(), installed({ id: 'vip-scoring', path: '/ext/vip' })],
      [offer(), offer({ id: 'vip-scoring', version: '2.0.0' })]
    );
    api.installFromRegistry.mockImplementation(async (id: string) =>
      id === 'otp-code' ? { success: false, error: 'checksum mismatch' } : { success: true }
    );
    const view = await mount();

    await click(button(view, 'Update all (2)'));

    expect(api.installFromRegistry).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('otp-code: checksum mismatch');
  });

  // Regression: a registry that could not be reached took the whole panel with
  // it, so an offline machine could not so much as turn an extension off.
  it('still draws the installed list when the registry cannot be reached', async () => {
    install([installed()], []);
    api.browse.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = await mount();

    expect(view.byLabel('Disable extension')).toBeTruthy();
    expect(button(view, 'Update all')).toBeUndefined();
    warn.mockRestore();
  });
});
