// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CategorizationTab } from '../../../../../src/components/settings/ai/CategorizationTab';
import { defaultSettings } from '../../../../../src/components/settings/types';
import type { AIProvider } from '../../../../../src/services/ai-service';
import { cleanup, fire, render, settle } from '../../../../helpers/render';

// What breaks if this suite goes red: the Categorization tab tells the user
// something about automatic sorting that is not true. It used to carry its own
// "Smart Email Categorization" switch that the pipeline never read, so turning
// it off stopped nothing while new mail kept going to the AI provider. The tab
// now shows the real state, which AI Assist (Email Agent tab) controls.

const PROVIDER = { id: 'p1', name: 'Test', type: 'openai', apiKey: 'k', model: 'm', isDefault: true } as unknown as AIProvider;
const AGENT_CONFIG_KEY = 'sarvinbox-agent-config';

const api = {
  ai: { getCategoryDefinitions: vi.fn(async () => ({ success: true, data: [] as unknown[] })) },
};

const mount = async (providers: AIProvider[], onOpenAgentTab = vi.fn()) => {
  const view = render(
    <CategorizationTab
      aiProviders={providers}
      settings={defaultSettings}
      updateSetting={() => {}}
      onOpenAgentTab={onOpenAgentTab}
    />,
  );
  await settle();
  const status = view.find('[data-testid="auto-sorting-status"]');
  const openButton = view.all('button').find((b) => b.textContent === 'Open Email Agent') ?? null;
  return { view, status, openButton, onOpenAgentTab };
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('window', Object.assign(globalThis.window, { electronAPI: api }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('CategorizationTab automatic-sorting status', () => {
  // Breaks: a user who connected a provider is told sorting is off (or not
  // told it is on), and is not shown where to turn it off.
  it('says sorting is ON with a provider and AI Assist on, and names AI Assist as the control', async () => {
    const { status, openButton } = await mount([PROVIDER]);
    expect(status?.textContent).toContain('On');
    expect(status?.textContent).toContain('New mail is sent to your AI provider');
    expect(status?.textContent).toContain('AI Assist');
    expect(openButton).not.toBeNull();
  });

  // Breaks: the tab claims sorting is on (or hides that it is off) when the
  // one real switch is off.
  it('says sorting is OFF when AI Assist is off', async () => {
    localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify({ enabled: false }));
    localStorage.setItem('sarvinbox-agent-config-version', '2');
    const { status } = await mount([PROVIDER]);
    expect(status?.textContent).toContain('Off');
    expect(status?.textContent).toContain('AI Assist is off, so new mail is not sent');
  });

  // Breaks: an unreadable AI Assist setting is shown as "on" while the app
  // treats it as off (the status must read through the same fail-closed load).
  it('says sorting is OFF when the stored AI Assist setting is unreadable', async () => {
    localStorage.setItem(AGENT_CONFIG_KEY, '{"enabled":tr');
    const { status } = await mount([PROVIDER]);
    expect(status?.textContent).toContain('Off');
  });

  // Breaks: with no provider connected the tab implies mail is being sent.
  it('says sorting is OFF with no provider, and offers no Email Agent link', async () => {
    const { status, openButton } = await mount([]);
    expect(status?.textContent).toContain('Off');
    expect(status?.textContent).toContain('No AI provider is connected');
    expect(openButton).toBeNull();
  });

  // Breaks: the link to the real switch goes nowhere.
  it('opens the Email Agent tab from the status row', async () => {
    const { openButton, onOpenAgentTab } = await mount([PROVIDER]);
    fire(openButton, 'click');
    expect(onOpenAgentTab).toHaveBeenCalledTimes(1);
  });

  // Breaks: THE bug. A second on/off control for sorting comes back that the
  // pipeline does not read. With no categories loaded, the tab has no toggle at
  // all, and a leftover "off" from the old switch changes nothing on screen.
  it('has no sorting switch of its own, and ignores the old switch’s stored value', async () => {
    localStorage.setItem('sarvinbox-ai-features', JSON.stringify([{ id: 'email-categorization', enabled: false }]));
    const { view, status } = await mount([PROVIDER]);
    expect(view.all('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Smart Email Categorization');
    expect(status?.textContent).toContain('On');
  });
});
