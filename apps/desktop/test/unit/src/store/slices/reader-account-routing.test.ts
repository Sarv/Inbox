import { describe, expect, it } from 'vitest';

import { createEmailActionsSlice } from '../../../../../src/store/slices/email-actions-slice';
import type { EmailStore } from '../../../../../src/store/types';
import { emailRecord } from '../../../../helpers/email-fixtures';

function fixture() {
  let state = {} as EmailStore;
  const actions = createEmailActionsSlice(() => {}, () => state, {} as never);
  state = { ...actions, selectedEmailId: 'shared-id', threadAccountId: 'source-owner', viewAccountId: 'source-owner',
    emails: [emailRecord({ id: 'shared-id', accountId: 'active-inbox-owner' })],
    threadEmails: [emailRecord({ id: 'shared-id' }), emailRecord({ id: 'thread-sibling' })],
    searchResults: [], sectionData: {},
  } as unknown as EmailStore;
  return { state, account: actions._accountIdFor };
}

describe('embedded reader action account routing', () => {
  it('uses the loaded source owner despite a same-ID row in another account’s inbox', () => {
    const { account } = fixture();
    expect(account('shared-id')).toBe('source-owner');
    expect(account('thread-sibling')).toBe('source-owner');
  });

  it('keeps ordinary list ownership when the source reader is not open', () => {
    const { state, account } = fixture();
    state.selectedEmailId = null;
    expect(account('shared-id')).toBe('active-inbox-owner');
  });

  it('does not reuse a stale thread stamp after another message was selected', () => {
    const { state, account } = fixture();
    state.selectedEmailId = 'unrelated-id';
    expect(account('shared-id')).toBe('active-inbox-owner');
  });
});
