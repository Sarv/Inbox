// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIBoxDashboard } from '../../../../../src/components/aibox/AIBoxDashboard';
import { cleanup, fire, render, settle } from '../../../../helpers/render';

// What breaks if this suite goes red: the AI dashboard's "Start Processing"
// button looks usable while AI Assist is off. The run it starts refuses to send
// mail with AI Assist off (the one sorting switch), so without this the click
// silently does nothing and the user is not told why.

const h = vi.hoisted(() => ({ processEmailsForAICategorization: vi.fn(async () => {}) }));

vi.mock('../../../../../src/store/email-store', () => {
  const state = {
    aiCategoryCountsLastUpdate: 0,
    aiProcessing: false,
    setAIBoxActiveTab: () => {},
    processEmailsForAICategorization: h.processEmailsForAICategorization,
  };
  return { useEmailStore: Object.assign(() => state, { setState: () => {}, getState: () => state }) };
});

const api = {
  ai: {
    getCategoryDefinitions: vi.fn(async () => ({ success: true, data: [] })),
    getCategoryCounts: vi.fn(async () => ({ success: true, data: {} })),
    getUnprocessedEmailCount: vi.fn(async () => ({ success: true, data: 0 })),
    getProcessingBreakdown: vi.fn(async () => ({ success: false })),
  },
  emails: {
    getBodyDownloadState: vi.fn(async () => ({ success: true, data: { active: false } })),
    onBodyDownloadProgress: vi.fn(() => () => {}),
  },
};

const mount = async () => {
  const view = render(<AIBoxDashboard />);
  await settle();
  const button = view.all('button').find((b) => /Start Processing|Process More/.test(b.textContent ?? '')) as HTMLButtonElement;
  return { view, button, note: view.find('[data-testid="ai-assist-off-note"]') };
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal('window', Object.assign(globalThis.window, { electronAPI: api }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('AIBoxDashboard "Start Processing" and AI Assist', () => {
  // Breaks: a button that silently does nothing, with no reason given.
  it('is disabled, with the reason, while AI Assist is off', async () => {
    localStorage.setItem('sarvinbox-agent-config', JSON.stringify({ enabled: false }));
    localStorage.setItem('sarvinbox-agent-config-version', '2');
    const { button, note } = await mount();
    expect(button.disabled).toBe(true);
    expect(note?.textContent).toContain('AI Assist is off');
    fire(button, 'click');
    expect(h.processEmailsForAICategorization).not.toHaveBeenCalled();
  });

  // Breaks: the manual run can no longer be started with AI Assist on.
  it('starts the run while AI Assist is on', async () => {
    const { button, note } = await mount();
    expect(button.disabled).toBe(false);
    expect(note).toBeNull();
    fire(button, 'click');
    expect(h.processEmailsForAICategorization).toHaveBeenCalledTimes(1);
  });
});
