// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionManager } from '../../../../../src/components/ExtensionManager';
import { ExtensionBrowser } from '../../../../../src/components/extensions/ExtensionBrowser';
import {
  ExtensionPermissionPrompt,
  type PermissionPromptExtension,
} from '../../../../../src/components/extensions/ExtensionPermissionPrompt';
import { act, render, type Mounted } from '../../../../helpers/render';

/**
 * Every control in the extensions surfaces names itself on hover.
 *
 * What breaks if this file goes red: the extensions screens go back to buttons
 * a user has to click to identify. Two of them are destructive or
 * consequential in a way a wrong guess cannot be taken back — Uninstall drops
 * the extension and its grants, Install hands a stranger's code the
 * permissions listed above it — and two of them (the power toggle, the
 * expand chevron) are icon-only, so without a tooltip they carry no label at
 * all. This also pins the toggle to the SHARED Tooltip rather than the native
 * `title` attribute, whose ~500ms fixed delay reads as "no tooltip".
 */

// The shared Tooltip opens on `mouseover` after `delayMs`, and portals its
// content to document.body — so hovering means dispatching that event and
// running the timer, and asserting means reading the whole body.
const hover = async (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
};

/** The tooltip bubble is the portalled node the component does not own. */
const tooltipText = () =>
  [...document.body.querySelectorAll('div.fixed.z-\\[9999\\]')]
    .map((node) => node.textContent ?? '')
    .join(' ');

const unhover = async (element: HTMLElement | null) => {
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    element!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
  });
};

const INSTALLED = {
  id: 'com.example.otp',
  source: 'marketplace' as const,
  path: '/ext/otp',
  version: '1.2.0',
  installedAt: 1_800_000_000_000,
  enabled: true,
  grantedPermissions: ['mail:read'],
  settings: {},
};

const INFO = {
  manifest: {
    id: 'com.example.otp',
    name: 'OTP Finder',
    version: '1.2.0',
    description: 'Surfaces verification codes',
    author: 'Example',
    permissions: ['mail:read'],
  },
  state: 'active',
  enabled: true,
  path: '/ext/otp',
  workflowIds: [],
};

const CATALOG_ITEM = {
  id: 'com.example.otp',
  name: 'OTP Finder',
  version: '1.2.0',
  description: 'Surfaces verification codes',
  author: 'Example',
  keywords: [],
  permissions: ['mail:read'],
  size: 2048,
  stats: { downloads: 10 },
  sourceUrl: 'https://example.test/otp',
  state: 'available' as const,
};

const PROMPT_EXTENSION: PermissionPromptExtension = {
  ...CATALOG_ITEM,
  download: { url: 'https://example.test/otp.zip', sha256: 'a'.repeat(64), size: 2048 },
};

const extensionsApi = {
  list: vi.fn(async () => ({ success: true, data: [INSTALLED] })),
  getInfo: vi.fn(async () => ({ success: true, data: INFO })),
  enable: vi.fn(async () => ({ success: true })),
  disable: vi.fn(async () => ({ success: true })),
  uninstall: vi.fn(async () => ({ success: true })),
  selectAndInstall: vi.fn(async () => ({ success: true })),
  browse: vi.fn(async () => ({
    success: true,
    data: { items: [CATALOG_ITEM], registries: [{ url: 'r', source: null, stars: 0, generatedAt: null, ok: true, fromCache: false }] },
  })),
  registryDetail: vi.fn(async () => ({ success: true, data: PROMPT_EXTENSION })),
  installFromRegistry: vi.fn(async () => ({ success: true })),
};

let mounted: Mounted | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as Record<string, unknown>).electronAPI = { extensions: extensionsApi };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).electronAPI;
});

/** Mount and let the component's initial IPC round-trip settle. */
const mount = async (element: Parameters<typeof render>[0]) => {
  const view = render(element);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  mounted = view;
  return view;
};

describe('ExtensionManager tooltips', () => {
  // Regression: the header controls lose their hover labels. Refresh and
  // Browse look interchangeable at a glance; the tabs are the only navigation.
  it('names the header controls and the tabs', async () => {
    const view = await mount(<ExtensionManager />);

    const refresh = view.all('button').find((b) => b.textContent?.includes('Refresh'))!;
    await hover(refresh);
    expect(tooltipText()).toContain('Re-read the installed extensions');
    await unhover(refresh);

    const browseTab = view.all('button').find((b) => b.textContent === 'Browse')!;
    await hover(browseTab);
    expect(tooltipText()).toContain('Extensions available to install');
  });

  // Regression: the enable/disable toggle is icon-only, and it previously used
  // the native `title` attribute — a ~500ms delay that reads as no tooltip at
  // all. Both the tooltip and the aria-label have to be there.
  it('names the icon-only power toggle through the shared Tooltip, not title=', async () => {
    const view = await mount(<ExtensionManager />);

    const toggle = view.byLabel('Disable extension')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('title')).toBeNull();

    await hover(toggle);
    expect(tooltipText()).toContain('Turn this extension off');
  });

  // Regression: the chevron is the only way to reach the permissions, the
  // screenshots and Uninstall, and it carries no text of its own.
  it('names the expand chevron and, once open, Uninstall', async () => {
    const view = await mount(<ExtensionManager />);

    const chevron = view.byLabel('Show details')!;
    await hover(chevron);
    expect(tooltipText()).toContain('Show details');
    await unhover(chevron);

    await act(async () => {
      chevron.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const uninstall = view.all('button').find((b) => b.textContent?.includes('Uninstall'))!;
    await hover(uninstall);
    expect(tooltipText()).toContain('Remove this extension and its permissions');
  });
});

describe('ExtensionBrowser tooltips', () => {
  // Regression: Install is the button that grants a stranger's code its
  // permissions, and Refresh is the only way past a cached list.
  it('names Refresh and the per-extension install button', async () => {
    const view = await mount(<ExtensionBrowser onInstalled={() => {}} />);

    const refresh = view.all('button').find((b) => b.textContent?.includes('Refresh'))!;
    await hover(refresh);
    expect(tooltipText()).toContain('Fetch the latest list from the registry');
    await unhover(refresh);

    const install = view.all('button').find((b) => b.textContent?.includes('Install'))!;
    await hover(install);
    expect(tooltipText()).toContain('Review what OTP Finder can do, then install');
  });
});

describe('ExtensionPermissionPrompt tooltips', () => {
  // Regression: this dialog's two buttons are grant-or-refuse. Saying which is
  // which on hover is the last chance to catch a misread before consent.
  it('names Cancel and Install', async () => {
    const view = await mount(
      <ExtensionPermissionPrompt
        extension={PROMPT_EXTENSION}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const cancel = view.all('button').find((b) => b.textContent === 'Cancel')!;
    await hover(cancel);
    expect(tooltipText()).toContain('Close without installing');
    await unhover(cancel);

    const install = view.all('button').find((b) => b.textContent === 'Install')!;
    await hover(install);
    expect(tooltipText()).toContain('Grant these permissions and install');
  });
});
