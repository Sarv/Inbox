import { describe, expect, it } from 'vitest';

import { INBOX_AGENT_WRITE_TOOLS } from '../../../../electron/services/inbox-assistant-agent-write-tools';
import { INBOX_AGENT_CHANGE_LIMITS, STANDING_ACTIONS } from '../../../../electron/services/inbox-assistant-change-sets';
import {
  ACTION_MODE_DESCRIPTION, APPROVE_FOR_ME_ACTIONS, APPROVE_FOR_ME_SCOPE, INBOX_AGENT_AUTO_APPLY_PER_REQUEST, INBOX_AGENT_UNDO_HOURS,
} from '../../../../src/utils/inbox-assistant-approval';

// What "Approve for me" covers is stated in three places that must agree: the
// actions and cap the host enforces, the words the user agrees to, and the
// scope a chat's consent is saved with. If they drift, a user consents to one
// thing and the agent does another, and saved consent stops resetting when the
// mode widens.

/** The actions change_mail offers the model, from its tool definition. */
function changeMailActions(): string[] {
  const tool = INBOX_AGENT_WRITE_TOOLS.find(item => item.definition.name === 'change_mail')!;
  const properties = (tool.definition.parameters as { properties: { action: { enum: string[] } } }).properties;
  return properties.action.enum;
}

describe('what Approve for me covers', () => {
  // Breaks: a new change_mail action auto-applies under consent recorded for
  // the old list, with no scope change, and the control's words omit it.
  it('lists exactly the change_mail actions that can apply without a card', () => {
    const autoApplicable = changeMailActions().filter(action => !STANDING_ACTIONS.has(action as never));
    expect([...APPROVE_FOR_ME_ACTIONS].sort()).toEqual(autoApplicable.sort());
    for (const action of APPROVE_FOR_ME_ACTIONS) expect(APPROVE_FOR_ME_SCOPE).toContain(action);
  });

  // Breaks: the cap is raised without the words or the stored consent following it.
  it('names the cap the change sets enforce, in the words and in the scope', () => {
    expect(INBOX_AGENT_CHANGE_LIMITS.autoApplyPerRun).toBe(INBOX_AGENT_AUTO_APPLY_PER_REQUEST);
    expect(ACTION_MODE_DESCRIPTION.approve_for_me).toContain(`Up to ${INBOX_AGENT_AUTO_APPLY_PER_REQUEST} emails per request`);
    expect(APPROVE_FOR_ME_SCOPE.split(':')[1]).toBe(String(INBOX_AGENT_AUTO_APPLY_PER_REQUEST));
  });

  // Breaks: the description promises an Undo window the change sets do not keep.
  it('states the Undo window the change sets keep', () => {
    expect(INBOX_AGENT_CHANGE_LIMITS.undoMs).toBe(INBOX_AGENT_UNDO_HOURS * 60 * 60_000);
    expect(ACTION_MODE_DESCRIPTION.approve_for_me).toContain(`for ${INBOX_AGENT_UNDO_HOURS} hours`);
  });

  // Breaks: the user turns the mode on without being told an action it allows, or what still asks.
  it('describes every kind of change it allows and everything that still asks', () => {
    const words = ACTION_MODE_DESCRIPTION.approve_for_me;
    for (const allowed of ['read or unread', 'star', 'archive', 'Trash', 'folder', 'category', 'label', 'snooze']) expect(words).toContain(allowed);
    for (const asks of ['Still asks first', 'protected emails', 'spam reports', 'new labels', 'filters', 'sender changes', 'never sends mail', 'deletes permanently']) expect(words).toContain(asks);
    expect(ACTION_MODE_DESCRIPTION.review).toContain('changes nothing until you approve');
  });

  // Breaks: the saved scope depends on something other than the list and the
  // cap, so it changes (resetting every chat) or stays (keeping old consent) by accident.
  it('derives the scope from the list and the cap alone', () => {
    expect(APPROVE_FOR_ME_SCOPE).toBe(`agent-1:${INBOX_AGENT_AUTO_APPLY_PER_REQUEST}:${APPROVE_FOR_ME_ACTIONS.join(',')}`);
  });
});
