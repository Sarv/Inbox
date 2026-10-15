// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDashboard } from '../../../../../src/components/agent/AgentDashboard';
import { cleanup, fire, render, settle, type Mounted } from '../../../../helpers/render';

// The agent overview now shares the AI Settings dashboard with processing
// progress. Moving it must preserve review, drafts, learning and navigation.
const ok = <T,>(data: T) => Promise.resolve({ success: true, data });
const draft = {
  id: 'draft-decision', emailId: 'draft-email', threadId: 'draft-thread',
  senderAddress: 'draft@example.com', proposedAction: 'reply', confidence: 0.9,
  reasoning: 'Reply needed', status: 'auto', userFeedback: null,
  proposedAt: 1000, resolvedAt: 1001, draftBody: 'Saved draft reply',
};
const proposal = {
  ...draft, id: 'proposal', emailId: 'proposal-email', status: 'pending',
  subject: 'Review subject', fromName: 'Review Sender', fromAddress: 'review@example.com',
};
const action = {
  id: 'action', emailId: 'action-email', actionType: 'archive', source: 'agent_auto',
  actionValue: null, senderAddress: 'activity@example.com', timestamp: 1002,
  subject: 'Activity subject', fromName: 'Activity Sender',
};
const offDraft = vi.fn();
const offPipeline = vi.fn();
const api = {
  agent: {
    getProposals: vi.fn(() => ok([proposal])),
    resolveProposal: vi.fn(() => ok({})),
    getDecisionHistory: vi.fn(() => ok([draft])),
    getAccuracyMetrics: vi.fn(() => ok({ total: 4, approved: 3, rejected: 1, accuracy: 0.75 })),
    getAgentActions: vi.fn(() => ok([action])),
    undoAction: vi.fn(() => ok({ undone: 'archive', emailId: action.emailId })),
    getActionStats: vi.fn(() => ok({ totalActions: 12, actionCounts: {}, topSenders: [{ email: 'vip@example.com', actionCount: 5 }], avgActionsPerDay: 3, mostActiveHour: 9 })),
    getSenderTiers: vi.fn(() => ok({ vip: ['vip@example.com'], noise: [], regular: [] })),
    getPeakHours: vi.fn(() => ok([9, 10])),
    getContactTypeCounts: vi.fn(() => ok({ colleague: 2 })),
    getLearningSummary: vi.fn(() => ok({ totalActions: 12, fromHistory: 8, fromLive: 4, uniqueSenders: 3 })),
    getPipelineStats: vi.fn(() => ok({ totalEmails: 900, agentPending: 12, agentDone: 777 })),
    getCategoryReadiness: vi.fn(() => ok([{ slug: 'finance', name: 'Finance', totalActions: 6, dominantAction: 'archive', rate: 1, ready: true }])),
    onDraftReady: vi.fn(() => offDraft),
    onPipelineStats: vi.fn(() => offPipeline),
  },
  emails: { get: vi.fn(() => ok({ subject: 'Saved draft subject', fromName: 'Draft Sender' })) },
};

function button(view: Mounted, text: string): HTMLElement {
  const found = view.all('button').find(row => row.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('sarvinbox-agent-config', JSON.stringify({ enabled: true, autoRead: true }));
  api.agent.getProposals.mockImplementation(() => ok([proposal]));
  api.agent.getDecisionHistory.mockImplementation(() => ok([draft]));
  api.agent.getAgentActions.mockImplementation(() => ok([action]));
  api.agent.getLearningSummary.mockImplementation(() => ok({ totalActions: 12, fromHistory: 8, fromLive: 4, uniqueSenders: 3 }));
  api.agent.getPipelineStats.mockImplementation(() => ok({ totalEmails: 900, agentPending: 12, agentDone: 777 }));
  vi.stubGlobal('window', Object.assign(globalThis.window, { electronAPI: api }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('embedded Email Agent overview', () => {
  it('retains unique metrics, reviews, drafts, activity and learning under a section heading', async () => {
    const view = render(<AgentDashboard />);
    await settle();
    const heading = view.find('#email-agent-overview-heading');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Email Agent');
    expect(view.find('section[aria-labelledby="email-agent-overview-heading"]')).not.toBeNull();
    expect(view.find('h1')).toBeNull();
    for (const content of ['Active', 'Learned from 12 actions across 3 senders', 'Downloaded emails finalized', '777', '12 eligible pending across all dates', 'Actions taken', 'Drafts ready', 'Disagreement rate', '25%', 'Needs your review', 'Review subject', 'Saved draft subject', 'Activity subject', 'Automation readiness', 'Most interaction', 'Sender tiers', 'Contacts by type']) {
      expect(view.container.textContent).toContain(content);
    }
  });

  it('opens proposal, draft, activity and contacts through the supplied navigation callbacks', async () => {
    const onNavigateToEmail = vi.fn();
    const onNavigateToContacts = vi.fn();
    const view = render(<AgentDashboard onNavigateToEmail={onNavigateToEmail} onNavigateToContacts={onNavigateToContacts} />);
    await settle();
    fire(button(view, 'Open draft'), 'click');
    fire(view.all('button').find(row => row.textContent?.includes('Saved draft subject'))!, 'click');
    fire(view.all('div').find(row => row.textContent === 'Activity subject')!, 'click');
    fire(button(view, 'Browse and edit in Contacts'), 'click');
    expect(onNavigateToEmail.mock.calls).toEqual([['proposal-email'], ['draft-email'], ['action-email']]);
    expect(onNavigateToContacts).toHaveBeenCalledOnce();
  });

  it('dismisses proposals and refreshes both agent data and the parent dashboard', async () => {
    const onRefresh = vi.fn();
    const view = render(<AgentDashboard onRefresh={onRefresh} />);
    await settle();
    fire(view.byLabel('Dismiss proposal from Review Sender'), 'click');
    await settle();
    expect(api.agent.resolveProposal).toHaveBeenCalledWith('proposal', false, 'dismissed');
    expect(view.container.textContent).not.toContain('Review subject');
    fire(view.byLabel('Refresh email agent'), 'click');
    await settle();
    expect(api.agent.getProposals).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledOnce();
    view.unmount();
    expect(offDraft).toHaveBeenCalledOnce();
    expect(offPipeline).toHaveBeenCalledOnce();
  });

  it('keeps the setup information and agent settings path when learning has not started', async () => {
    localStorage.setItem('sarvinbox-agent-config', JSON.stringify({ enabled: false }));
    api.agent.getProposals.mockImplementation(() => ok([]));
    api.agent.getDecisionHistory.mockImplementation(() => ok([]));
    api.agent.getAgentActions.mockImplementation(() => ok([]));
    api.agent.getLearningSummary.mockImplementation(() => ok({ totalActions: 0, fromHistory: 0, fromLive: 0, uniqueSenders: 0 }));
    api.agent.getPipelineStats.mockImplementation(() => ok({ totalEmails: 0, agentPending: 0, agentDone: 0 }));
    const view = render(<AgentDashboard />);
    await settle();
    for (const content of ['Your email agent is getting set up', 'Observes', 'Learns', 'Acts', 'AI → Email Agent']) {
      expect(view.container.textContent).toContain(content);
    }
  });
});
