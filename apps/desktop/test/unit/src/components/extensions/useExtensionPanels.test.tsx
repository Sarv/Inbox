// @vitest-environment happy-dom
import type { AvailablePanel } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import {
  panelsForSurface,
  useExtensionPanels,
} from '../../../../../src/components/extensions/useExtensionPanels';
import { render, settle } from '../../../../helpers/render';

/**
 * The list of panels the mail view is allowed to show.
 *
 * What breaks if this file goes red: either a panel the user granted never
 * appears, or — the one that matters — the app keeps drawing a panel whose
 * extension has been disabled or uninstalled, leaving a frame on screen that
 * goes on asking main for mail it is no longer permitted to have. Main refuses
 * it, but the reader sees a live-looking panel that is anything but.
 */

const sidebarPanel: AvailablePanel = {
  extensionId: 'com.example.notes',
  extensionName: 'Notes',
  panel: { id: 'notes', title: 'Notes', entry: 'panel.html', surface: 'sidebar' },
  url: 'sarv-extension://com.example.notes/panel.html',
};

const modalPanel: AvailablePanel = {
  extensionId: 'com.example.tools',
  extensionName: 'Tools',
  panel: { id: 'tools', title: 'Tools', entry: 'tools.html', surface: 'modal' },
  url: 'sarv-extension://com.example.tools/tools.html',
};

const listPanels = vi.fn();
let mounted: ReturnType<typeof render> | null = null;
let seen: AvailablePanel[] = [];
let refresh: () => Promise<void> = async () => {};

function Probe() {
  const result = useExtensionPanels();
  seen = result.panels;
  refresh = result.refresh;
  return null;
}

async function mountProbe() {
  mounted = render(<Probe />);
  await settle();
}

beforeEach(() => {
  seen = [];
  listPanels.mockReset().mockResolvedValue({ success: true, data: [sidebarPanel, modalPanel] });
  (window as unknown as Record<string, unknown>).electronAPI = {
    extensions: { listPanels },
  };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  delete (window as unknown as Record<string, unknown>).electronAPI;
});

describe('useExtensionPanels', () => {
  // The happy path: what main says is grantable is what the app offers.
  it('reads the panels main reports', async () => {
    await mountProbe();
    expect(seen).toEqual([sidebarPanel, modalPanel]);
  });

  // A failed read must not take the mail view down with it — panels are
  // additive, and the message beside them still has to render.
  it('shows no panels when the list cannot be read', async () => {
    listPanels.mockResolvedValue({ success: false, error: 'Extensions are not running' });
    await mountProbe();
    expect(seen).toEqual([]);
  });

  // Same for an outright throw: a dead IPC channel is a transient condition,
  // not a reason to break rendering.
  it('shows no panels when the call throws', async () => {
    listPanels.mockRejectedValue(new Error('channel closed'));
    await mountProbe();
    expect(seen).toEqual([]);
  });

  // The revocation path: disabling an extension has to remove its panel on the
  // next read, or a frame outlives the permission that justified it.
  it('drops a panel whose extension was disabled', async () => {
    await mountProbe();
    expect(seen).toHaveLength(2);
    listPanels.mockResolvedValue({ success: true, data: [modalPanel] });
    await refresh();
    await settle();
    expect(seen).toEqual([modalPanel]);
  });
});

describe('panelsForSurface', () => {
  // A modal panel drawn into the sidebar (or the reverse) is a panel in a
  // surface it was never designed or reviewed for.
  it('keeps each panel to the surface it declared', () => {
    const panels = [sidebarPanel, modalPanel];
    expect(panelsForSurface(panels, 'sidebar')).toEqual([sidebarPanel]);
    expect(panelsForSurface(panels, 'modal')).toEqual([modalPanel]);
  });

  it('returns nothing when no panel claims the surface', () => {
    expect(panelsForSurface([modalPanel], 'sidebar')).toEqual([]);
  });
});
