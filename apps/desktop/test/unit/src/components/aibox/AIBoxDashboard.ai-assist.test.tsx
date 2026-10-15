// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIBoxDashboard } from '../../../../../src/components/aibox/AIBoxDashboard';
import { cleanup, fire, render, settle } from '../../../../helpers/render';

// What breaks if this suite goes red: the AI dashboard's "Start Processing"
// button looks usable while AI Assist is off. The run it starts refuses to send
// mail with AI Assist off (the one sorting switch), so without this the click
// silently does nothing and the user is not told why.

const h = vi.hoisted(() => ({
  processEmailsForAICategorization: vi.fn(async () => {}),
  loadAICategoryEmails: vi.fn(async (_category: string) => {}),
}));

vi.mock('../../../../../src/store/email-store', () => {
  const state = {
    aiCategoryCountsLastUpdate: 0,
    aiProcessing: false,
    loadAICategoryEmails: h.loadAICategoryEmails,
    processEmailsForAICategorization: h.processEmailsForAICategorization,
  };
  return { useEmailStore: Object.assign(() => state, { setState: () => {}, getState: () => state }) };
});

const api = {
  ai: {
    getCategoryDefinitions: vi.fn(async () => ({ success: true, data: [] as Array<Record<string, unknown>> })),
    getCategoryCounts: vi.fn(async () => ({ success: true, data: {} })),
    getUnprocessedEmailCount: vi.fn(async () => ({ success: true, data: 0 })),
    getProcessingBreakdown: vi.fn(async (): Promise<{ success: boolean; data?: Record<string, number> }> => ({ success: false })),
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

describe('AI Dashboard category navigation and processing scopes', () => {
  it('lets app navigation guard the category action before changing the mail view', async () => {
    api.ai.getCategoryDefinitions.mockResolvedValueOnce({ success: true, data: [
      { slug: 'finance', name: 'Finance', icon: 'Tag', color: 'blue', isEnabled: true },
    ] });
    api.ai.getCategoryCounts.mockResolvedValueOnce({ success: true, data: { finance: 12 } });
    const onNavigateToCategory = vi.fn();
    const view = render(<AIBoxDashboard onNavigateToCategory={onNavigateToCategory} />);
    await settle();
    fire(view.all('button').find((element) => element.textContent?.includes('Finance')) ?? null, 'click');
    expect(onNavigateToCategory).toHaveBeenCalledWith('finance');
    expect(h.loadAICategoryEmails).not.toHaveBeenCalled();
  });

  it('loads category mail when used without an app navigation callback', async () => {
    api.ai.getCategoryDefinitions.mockResolvedValueOnce({ success: true, data: [
      { slug: 'finance', name: 'Finance', icon: 'Tag', color: 'blue', isEnabled: true },
    ] });
    api.ai.getCategoryCounts.mockResolvedValueOnce({ success: true, data: { finance: 12 } });
    const { view } = await mount();
    fire(view.all('button').find((element) => element.textContent?.includes('Finance')) ?? null, 'click');
    expect(h.loadAICategoryEmails).toHaveBeenCalledWith('finance');
  });

  it('keeps processing-window backlog separate from all synced mail completed by the agent', async () => {
    api.ai.getCategoryCounts.mockResolvedValueOnce({ success: true, data: { finance: 2, important: 2 } });
    api.ai.getProcessingBreakdown.mockResolvedValueOnce({ success: true, data: {
      total: 50, withBody: 30, noBody: 20, readSkipped: 5,
      aiProcessed: 15, eligibleNow: 2, unreadWithBody: 10, unreadNoBody: 8,
      agentPending: 3, agentDone: 20, pending: 5,
    } });
    const { view } = await mount();
    const rows = view.all('div').filter((element) => element.children.length === 2
      && element.firstElementChild?.tagName === 'SPAN'
      && element.lastElementChild?.tagName === 'SPAN');
    const valueFor = (label: string) => rows.find((row) => row.firstElementChild?.textContent === label)?.lastElementChild?.textContent;
    expect(valueFor('Waiting for priority + actions (current processing window)')).toBe('3');
    expect(valueFor('Agent processing finalized (all synced mail)')).toBe('20');
    expect(view.container.textContent).toContain('15 processed');
    expect(view.container.textContent).toContain('75% complete');
    expect(view.container.textContent).not.toContain('4 processed');
  });

  it('retains processing history and category cards when all categorized conversations are read', async () => {
    api.ai.getCategoryDefinitions.mockResolvedValueOnce({ success: true, data: [
      { slug: 'finance', name: 'Finance', icon: 'Tag', color: 'blue', isEnabled: true },
    ] });
    api.ai.getCategoryCounts.mockResolvedValueOnce({ success: true, data: { finance: 0 } });
    api.ai.getProcessingBreakdown.mockResolvedValueOnce({ success: true, data: {
      total: 15, withBody: 15, noBody: 0, readSkipped: 15,
      aiProcessed: 15, eligibleNow: 0, unreadWithBody: 0, unreadNoBody: 0,
      agentPending: 0, agentDone: 15, pending: 0,
    } });
    const { view } = await mount();
    expect(view.container.textContent).toContain('15 processed');
    expect(view.container.textContent).toContain('Unread conversations by category');
    expect(view.all('button').some((element) => element.textContent?.includes('Finance'))).toBe(true);
    expect(view.container.textContent).not.toContain('No categories yet');
  });
});
