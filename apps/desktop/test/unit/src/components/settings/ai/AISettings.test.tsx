// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AISettings } from '../../../../../../src/components/settings/ai/AISettings';
import { cleanup, fire, render } from '../../../../../helpers/render';

const store = vi.hoisted(() => ({ reloadInboxSettings: vi.fn(), setState: vi.fn() }));
vi.mock('../../../../../../src/store/email-store', () => ({
  useEmailStore: { getState: () => store, setState: store.setState },
}));
vi.mock('../../../../../../src/services/ai-service', () => ({ loadAISettings: () => ({ providers: [] }) }));
vi.mock('../../../../../../src/components/aibox/AIBoxDashboard', () => ({
  AIBoxDashboard: ({ onNavigateToCategory }: { onNavigateToCategory?: (category: string) => void }) => (
    <section aria-label="AI processing"><button onClick={() => onNavigateToCategory?.('finance')}>Open category mail</button></section>
  ),
}));
vi.mock('../../../../../../src/components/agent/AgentDashboard', () => ({
  AgentDashboard: ({ onNavigateToEmail, onNavigateToContacts, onRefresh }: {
    onNavigateToEmail?: (emailId: string) => void;
    onNavigateToContacts?: () => void;
    onRefresh?: () => void;
  }) => (
    <section aria-label="Agent overview">
      <button onClick={() => onNavigateToEmail?.('proposal-email')}>Open agent email</button>
      <button onClick={onNavigateToContacts}>Browse contacts</button>
      <button onClick={onRefresh}>Refresh agent</button>
    </section>
  ),
}));
vi.mock('../../../../../../src/components/settings/ai/ProvidersTab', () => ({ ProvidersTab: () => <h2>Provider configuration</h2> }));
vi.mock('../../../../../../src/components/settings/ai/SignatureTab', () => ({ SignatureTab: () => <h2>Signature configuration</h2> }));
vi.mock('../../../../../../src/components/settings/ai/ConversationTab', () => ({ ConversationTab: () => <h2>Conversation configuration</h2> }));
vi.mock('../../../../../../src/components/settings/ai/AgentTab', () => ({ AgentTab: () => <h2>Agent configuration</h2> }));
vi.mock('../../../../../../src/components/settings/ai/CategorizationTab', () => ({
  CategorizationTab: ({ onOpenAgentTab, updateSetting }: {
    onOpenAgentTab: () => void;
    updateSetting: (key: 'maxEmailsPerFolder', value: number) => void;
  }) => (
    <section aria-label="Categorization configuration">
      <h2>Categorization configuration</h2>
      <button onClick={onOpenAgentTab}>Open Email Agent</button>
      <button onClick={() => updateSetting('maxEmailsPerFolder', 250)}>Change categorization setting</button>
    </section>
  ),
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

const button = (view: ReturnType<typeof render>, label: string) =>
  view.all('button').find((element) => element.textContent === label) ?? null;

describe('combined AI page', () => {
  it('keeps AI processing first and the agent overview below it on Dashboard', () => {
    const view = render(<AISettings />);
    expect(view.find('h1')?.textContent).toBe('AI');
    expect(view.all('section').map((section) => section.getAttribute('aria-label')))
      .toEqual(['AI processing', 'Agent overview']);
    expect(view.find('h2')).toBeNull(); // No configuration tab replaces either dashboard.
  });

  it('preserves every configuration tab and returns to the combined Dashboard', () => {
    const view = render(<AISettings />);
    const tabs = [
      ['Providers', 'Provider configuration'],
      ['Categorization', 'Categorization configuration'],
      ['Signatures', 'Signature configuration'],
      ['Conversation Mode', 'Conversation configuration'],
      ['Email Agent', 'Agent configuration'],
    ];
    for (const [label, content] of tabs) {
      fire(button(view, label!), 'click');
      expect(view.container.textContent).toContain(content);
      expect(view.byLabel('AI processing')).toBeNull();
      expect(view.byLabel('Agent overview')).toBeNull();
    }
    fire(button(view, 'Dashboard'), 'click');
    expect(view.byLabel('AI processing')).not.toBeNull();
    expect(view.byLabel('Agent overview')).not.toBeNull();
  });

  it('keeps the standalone Inbox Agent out of the AI configuration tabs', () => {
    const view = render(<AISettings />);
    expect(button(view, 'Assistant')).toBeNull();
    expect(button(view, 'Inbox Agent')).toBeNull();
    expect(button(view, 'Dashboard')).not.toBeNull();
    expect(button(view, 'Email Agent')).not.toBeNull();
  });

  it('keeps the categorization shortcut pointed at agent configuration', () => {
    const view = render(<AISettings initialTab="categorization" />);
    fire(button(view, 'Open Email Agent'), 'click');
    expect(view.find('h2')?.textContent).toBe('Agent configuration');
    expect(view.byLabel('Agent overview')).toBeNull();
  });

  it('keeps provider deep links separate from the default Dashboard', () => {
    const view = render(<AISettings initialTab="providers" />);
    expect(view.find('h2')?.textContent).toBe('Provider configuration');
    expect(view.byLabel('Agent overview')).toBeNull();
  });

  it('follows provider deep links and returns to Dashboard without remounting the page', () => {
    const view = render(<AISettings />);
    view.rerender(<AISettings initialTab="providers" />);
    expect(view.find('h2')?.textContent).toBe('Provider configuration');
    expect(view.byLabel('Agent overview')).toBeNull();
    view.rerender(<AISettings />);
    expect(view.byLabel('AI processing')).not.toBeNull();
    expect(view.byLabel('Agent overview')).not.toBeNull();
  });

  it('honors repeated provider shortcuts and sidebar Dashboard requests after changing tabs', () => {
    const view = render(<AISettings initialTab="providers" tabRequestId={1} />);
    fire(button(view, 'Dashboard'), 'click');
    view.rerender(<AISettings initialTab="providers" tabRequestId={2} />);
    expect(view.find('h2')?.textContent).toBe('Provider configuration');
    view.rerender(<AISettings tabRequestId={3} />);
    fire(button(view, 'Providers'), 'click');
    view.rerender(<AISettings tabRequestId={4} />);
    expect(view.byLabel('Agent overview')).not.toBeNull();
  });

  it('connects category, agent email and contact actions and refreshes processing counts', () => {
    const onNavigateToCategory = vi.fn();
    const onNavigateToEmail = vi.fn();
    const onNavigateToContacts = vi.fn();
    const view = render(<AISettings {...{ onNavigateToCategory, onNavigateToEmail, onNavigateToContacts }} />);
    fire(button(view, 'Open category mail'), 'click');
    fire(button(view, 'Open agent email'), 'click');
    fire(button(view, 'Browse contacts'), 'click');
    fire(button(view, 'Refresh agent'), 'click');
    expect(onNavigateToCategory).toHaveBeenCalledWith('finance');
    expect(onNavigateToEmail).toHaveBeenCalledWith('proposal-email');
    expect(onNavigateToContacts).toHaveBeenCalledOnce();
    expect(store.setState).toHaveBeenCalledWith({ aiCategoryCountsLastUpdate: expect.any(Number) });
  });

  it('preserves categorization Save and the unsaved-changes guard', () => {
    const onDirtyChange = vi.fn();
    const view = render(<AISettings initialTab="categorization" onDirtyChange={onDirtyChange} />);
    fire(button(view, 'Change categorization setting'), 'click');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fire(button(view, 'Save Changes'), 'click');
    expect(JSON.parse(localStorage.getItem('sarvinbox-settings')!)).toMatchObject({ maxEmailsPerFolder: 250 });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(store.reloadInboxSettings).toHaveBeenCalledOnce();
  });
});
