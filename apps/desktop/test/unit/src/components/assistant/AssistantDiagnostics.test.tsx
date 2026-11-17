// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantDiagnostics } from '../../../../../src/components/assistant/AssistantDiagnostics';
import type { InboxAssistantExchange } from '../../../../../src/types/inbox-assistant';
import { cleanup, fire, render, settle, toggle } from '../../../../helpers/render';

// The only way a bad answer reaches the developer: the user copies this report.

const writeText = vi.fn(async (_text: string) => {});
const exchange = (diagnostics: unknown): InboxAssistantExchange => ({
  id: 'exchange', requestId: 'req-1', status: 'completed', question: 'What did we quote Zylophant?', accountIds: ['primary'], createdAt: 1,
  answer: { text: 'Private answer', sources: [], coverage: [], warnings: [] }, diagnostics,
}) as InboxAssistantExchange;
const SEARCH = { version: 1, route: 'search', outcome: 'verified',
  plan: { source: 'model', followUp: false, intent: 'all', quoteIntent: true, meetingIntent: false, invitationIntent: false, timeWindow: false, filters: [],
    queryCount: 1, topicTermCount: 0, participantTermCount: 0, requiredGroupCount: 0,
    terms: { queries: ['Zylophant'], entityTerms: ['Zylophant'], topicTerms: [], participantTerms: [], requiredTopicGroups: [] } } };

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.stubGlobal('electronAPI', undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Copy diagnostics in the activity panel', () => {
  // Breaks: the report copied by default contains the user's search words (which
  // come from their question), or the panel shows the private question.
  it('copies a report without the search words unless the box is ticked', async () => {
    const view = render(<AssistantDiagnostics exchange={exchange(SEARCH)} />);
    expect(view.byLabel('Answer diagnostics')?.textContent).toContain('The AI planned the search.');
    const checkbox = view.find('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fire(view.find('button'), 'click');
    await settle();
    expect(writeText).toHaveBeenCalledTimes(1);
    const first = writeText.mock.calls[0]![0];
    expect(first).not.toContain('Zylophant');
    expect(first).not.toContain('Private answer');
    expect(JSON.parse(first)).toMatchObject({ report: 'sarv-inbox-agent-diagnostics', requestId: 'req-1', route: 'search', plan: { source: 'model', queryCount: 1 } });

    toggle(checkbox);
    fire(view.find('button'), 'click');
    await settle();
    expect(JSON.parse(writeText.mock.calls[1]![0])).toMatchObject({ plan: { searchWords: { queries: ['Zylophant'] } } });
  });

  // Breaks: a report arrives with no way to tell which build produced it.
  it('adds the app version to the report when the app can supply it', async () => {
    vi.stubGlobal('electronAPI', { app: { getVersion: async () => ({ success: true, data: '1.5.0' }) } });
    const view = render(<AssistantDiagnostics exchange={exchange(SEARCH)} />);
    await settle();
    fire(view.find('button'), 'click');
    await settle();
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ appVersion: '1.5.0' });
  });

  // Breaks: an answer saved before diagnostics existed shows an empty section
  // with a button that copies nothing useful; or a run that never searched
  // offers to include search words it does not have.
  it('is absent for an answer with no diagnostics, and offers no search words for a run that did not search', () => {
    expect(render(<AssistantDiagnostics exchange={exchange(undefined)} />).container.textContent).toBe('');
    cleanup();
    const view = render(<AssistantDiagnostics exchange={exchange({ version: 1, route: 'capability', outcome: 'capability' })} />);
    expect(view.find('input[type="checkbox"]')).toBeNull();
    expect(view.find('button')?.textContent).toContain('Copy diagnostics');
  });

  // Breaks: the clipboard refuses (window not focused) and the button still
  // says nothing, so the user sends an empty paste.
  it('says so when the copy fails', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const view = render(<AssistantDiagnostics exchange={exchange(SEARCH)} />);
    fire(view.find('button'), 'click');
    await settle();
    expect(view.find('button')?.textContent).toContain('Copy failed');
  });
});
