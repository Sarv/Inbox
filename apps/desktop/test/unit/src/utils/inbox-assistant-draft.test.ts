import { describe, expect, it, vi } from 'vitest';

import type { EmailStore } from '../../../../src/store/types';
import type { InboxAssistantDraft } from '../../../../src/types/inbox-assistant';
import { openInboxAssistantDraft } from '../../../../src/utils/inbox-assistant-draft';

const draft: InboxAssistantDraft = { chatId: 'chat-1', accountId: 'sales', to: ['buyer@example.com'], cc: ['team@example.com'], subject: 'TCS proposal', body: 'Hello <team> & buyer,\n\nPlease review <img src=x onerror=alert(1)>.' };
function fixture() {
  return { accounts: [{ id: 'work', email: 'work@example.com' }, { id: 'sales', email: 'sales@example.com' }], compose: { isOpen: false, mode: 'new' }, editDraftInComposer: vi.fn(), sendEmail: vi.fn() } as unknown as Pick<EmailStore, 'accounts' | 'compose' | 'editDraftInComposer'> & { sendEmail: ReturnType<typeof vi.fn> };
}

describe('Inbox Agent handoff to the existing mail composer', () => {
  it('keeps the selected From account and recipients, escapes generated text, and never sends', () => {
    const store = fixture();
    openInboxAssistantDraft(draft, store);
    expect(store.editDraftInComposer).toHaveBeenCalledExactlyOnceWith({ accountId: 'sales', to: 'buyer@example.com', cc: 'team@example.com', subject: 'TCS proposal', htmlContent: '<p>Hello &lt;team&gt; &amp; buyer,</p><p>&nbsp;</p><p>Please review &lt;img src=x onerror=alert(1)&gt;.</p>', attachments: [] });
    expect(store.sendEmail).not.toHaveBeenCalled();
  });

  it('preserves an already-open email and rejects a removed sending account', () => {
    const store = fixture();
    store.compose.isOpen = true;
    expect(() => openInboxAssistantDraft(draft, store)).toThrow('Close the current email draft');
    store.compose.isOpen = false;
    store.accounts = store.accounts.filter(account => account.id !== 'sales');
    expect(() => openInboxAssistantDraft(draft, store)).toThrow('sending account is no longer connected');
    expect(store.editDraftInComposer).not.toHaveBeenCalled();
  });
});
