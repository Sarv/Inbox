import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it } from 'vitest';

import { panelMessageAccount } from '../../../src/components/extensions/panel-message-context';

const row = (id: string, accountId?: string) => ({ id, accountId }) as EmailRecord;
const state = () => ({ selectedEmailId: 'chosen', emails: [] as EmailRecord[], threadEmails: [] as EmailRecord[],
  activeAccountId: 'active-account', threadAccountId: null as string | null, viewAccountId: null as string | null });

describe('extension panel mailbox context', () => {
  it('uses the explicitly opened account even when equal message ids exist in another mailbox', () => {
    expect(panelMessageAccount({ ...state(), viewAccountId: 'opened-account', emails: [row('chosen', 'other-account')] })).toBe('opened-account');
  });
  it('uses the All Inboxes row owner while its thread is still loading', () => {
    expect(panelMessageAccount({ ...state(), emails: [row('chosen', 'row-account')], threadAccountId: 'stale-account' })).toBe('row-account');
  });
  it('uses the loaded thread owner only if that thread contains the selected message', () => {
    expect(panelMessageAccount({ ...state(), threadEmails: [row('chosen')], threadAccountId: 'thread-account' })).toBe('thread-account');
    expect(panelMessageAccount({ ...state(), threadEmails: [row('old-message')], threadAccountId: 'stale-account' })).toBe('active-account');
  });
  it('returns no mailbox when no message is selected', () => {
    expect(panelMessageAccount({ ...state(), selectedEmailId: null })).toBeUndefined();
  });
});
