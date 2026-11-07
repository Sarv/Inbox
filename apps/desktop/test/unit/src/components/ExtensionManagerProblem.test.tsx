// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionManager } from '../../../../src/components/ExtensionManager';
import { act, render } from '../../../helpers/render';

/**
 * The line in Settings saying why an extension is not working. This is where someone
 * goes after a card, and the only record once the card is gone. An old extension using
 * a Node API it no longer has must never just look switched on and do nothing.
 */

const manifest = {
  id: 'old',
  name: 'Old Extension',
  version: '1.0.0',
  description: 'd',
  author: 'a',
  permissions: [],
};

function stubApi(info: { state: string; error?: string }) {
  (window as unknown as Record<string, unknown>).electronAPI = {
    extensions: {
      list: async () => ({
        success: true,
        data: [{ id: 'old', version: '1.0.0', enabled: true, grantedPermissions: [], path: '/x', source: 'local', settings: {}, installedAt: 1 }],
      }),
      getInfo: async () => ({ success: true, data: { manifest, enabled: true, path: '/x', workflowIds: [], ...info } }),
      browse: async () => ({ success: true, data: { items: [], registries: [] } }),
    },
  };
}

async function mount() {
  const view = render(<ExtensionManager />);
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  });
  return view;
}

describe('ExtensionManager: an extension that is not working', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  // The upgrade case: it failed to start, and this names what it needs.
  it('says why when it failed to start', async () => {
    stubApi({ state: 'error', error: 'This extension uses Node\'s "fs"' });
    const view = await mount();

    expect(view.container.textContent).toContain('This extension uses Node\'s "fs"');
    view.unmount();
  });

  // It stays active when only part of it needs Node, as when a workflow does. Showing
  // the line only in the error state would leave it looking fine and failing on every mail.
  it('says why when it is running but part of it fails', async () => {
    stubApi({ state: 'active', error: 'This extension uses Node\'s "process"' });
    const view = await mount();

    expect(view.container.textContent).toContain('This extension uses Node\'s "process"');
    view.unmount();
  });

  it('says nothing when nothing is wrong', async () => {
    stubApi({ state: 'active' });
    const view = await mount();

    expect(view.container.textContent).toContain('Old Extension');
    expect(view.container.textContent).not.toContain('uses Node');
    view.unmount();
  });
});

describe('ExtensionManager: extensions held back at launch', () => {
  const stubHeld = (held: string[], startHeldBack = vi.fn(async () => ({ success: true }))) => {
    stubApi({ state: 'error', error: 'Not started' });
    const extensions = (window as unknown as { electronAPI: { extensions: Record<string, unknown> } }).electronAPI.extensions;
    extensions.getHeldBack = async () => held;
    extensions.startHeldBack = startHeldBack;
    return startHeldBack;
  };
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  // The crash-loop backstop only works if this is the way back: the card sends people here.
  it('offers the way back, and takes it', async () => {
    const start = stubHeld(['old']);
    const view = await mount();
    expect(view.container.textContent).toContain('Extensions did not start');
    expect(view.container.textContent).toContain('untouched');

    const button = view.all('button').find((node) => node.textContent?.trim() === 'Turn extensions back on');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });

    expect(start).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('says nothing when nothing is held back', async () => {
    stubHeld([]);
    const view = await mount();
    expect(view.container.textContent).not.toContain('Extensions did not start');
    view.unmount();
  });
});
