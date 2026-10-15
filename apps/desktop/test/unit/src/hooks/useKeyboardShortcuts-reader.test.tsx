// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock('../../../../src/store/email-store', () => ({ useEmailStore: { getState: () => h.state } }));

import { useKeyboardShortcuts } from '../../../../src/hooks/useKeyboardShortcuts';
import { act, cleanup, render } from '../../../helpers/render';

function Probe() {
  useKeyboardShortcuts({ setActiveSection: vi.fn(), focusSearch: vi.fn(), enabled: true, allowListNavigation: false });
  return <div>Embedded reader</div>;
}
function key(value: string) { act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); }); }

beforeEach(() => {
  localStorage.clear();
  h.state = {
    selectedEmailId: null, highlightedEmailId: 'background-email', threadAccountId: null, threadEmails: [],
    emails: [{ id: 'background-email', accountId: 'active' }], searchResults: [], searchQuery: 'old mail filter',
    compose: { isOpen: false }, getNavigationThreads: vi.fn(() => [{ threadId: 'background-thread', emails: [{ id: 'background-email' }] }]),
    archiveEmail: vi.fn(), deleteEmail: vi.fn(), bulkRemoveEmails: vi.fn(), clearSelectedEmail: vi.fn(), clearSearch: vi.fn(),
  };
});
afterEach(cleanup);

describe('embedded mail reader shortcuts', () => {
  it('cannot archive or delete a background inbox row while the source is loading', () => {
    render(<Probe />);
    key('d'); key('e');
    expect(h.state.deleteEmail).not.toHaveBeenCalled();
    expect(h.state.archiveEmail).not.toHaveBeenCalled();
    expect(h.state.bulkRemoveEmails).not.toHaveBeenCalled();
    h.state.selectedEmailId = 'source-email';
    h.state.threadAccountId = 'source-account';
    key('d');
    expect(h.state.deleteEmail).not.toHaveBeenCalled();
    h.state.threadEmails = [{ id: 'source-email', accountId: 'source-account' }];
    key('d');
    expect(h.state.deleteEmail).toHaveBeenCalledExactlyOnceWith('source-email');
    expect(h.state.getNavigationThreads).not.toHaveBeenCalled();
  });

  it('closes the source reader with Escape without changing a background mail search', () => {
    h.state.selectedEmailId = 'source-email'; h.state.threadAccountId = 'source-account';
    h.state.threadEmails = [{ id: 'source-email', accountId: 'source-account' }];
    render(<Probe />);
    key('Escape');
    expect(h.state.clearSelectedEmail).toHaveBeenCalledOnce();
    expect(h.state.clearSearch).not.toHaveBeenCalled();
  });
});
