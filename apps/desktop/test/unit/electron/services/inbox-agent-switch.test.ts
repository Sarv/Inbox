import { describe, expect, it, vi } from 'vitest';

import { inboxAgentToolsEnabled } from '../../../../electron/services/inbox-agent-switch';
import { INBOX_AGENT_SETTINGS_KEY, parseInboxAgentSettings } from '../../../../src/config/inbox-agent-settings';

// Which Inbox Agent a typed request reaches. A regression here is the user's
// "Tools" switch ignored (on or off), or a setting store that cannot be read
// sending requests to the agent that changes mail instead of the earlier paths.
describe('the Inbox Agent tools switch', () => {
  // Breaks: a malformed or missing stored value turns the agent on, or a stored "on" is not read.
  it('reads the stored switch, defaulting to off', () => {
    expect(parseInboxAgentSettings(null)).toEqual({ toolAgent: false });
    expect(parseInboxAgentSettings('{oops')).toEqual({ toolAgent: false });
    expect(parseInboxAgentSettings('null')).toEqual({ toolAgent: false });
    expect(parseInboxAgentSettings('{"toolAgent":"yes"}')).toEqual({ toolAgent: false });
    expect(parseInboxAgentSettings('{"toolAgent":true}')).toEqual({ toolAgent: true });
  });

  // Breaks: the switch is read from a different key than the one the header writes.
  it('follows the user\'s setting, and the development switch', () => {
    const read = vi.fn((key: string) => key === INBOX_AGENT_SETTINGS_KEY ? '{"toolAgent":true}' : null);
    expect(inboxAgentToolsEnabled(read, {})).toBe(true);
    expect(inboxAgentToolsEnabled(() => '{"toolAgent":false}', {})).toBe(false);
    expect(inboxAgentToolsEnabled(() => '{"toolAgent":false}', { SARVINBOX_AGENT_HARNESS: '1' })).toBe(true);
  });

  // Breaks: an unreadable settings store turns the tool-using agent on, or throws into the request.
  it('uses the earlier paths when the setting cannot be read', () => {
    expect(inboxAgentToolsEnabled(() => { throw new Error('locked'); }, {})).toBe(false);
  });
});
