/**
 * Inbox Agent preferences: one managed app setting (mirrored to the core
 * database by app-settings-sync), read by the Settings tab and by the main
 * process on every request.
 */

export const INBOX_AGENT_SETTINGS_KEY = 'sarvinbox-inbox-agent';

export interface InboxAgentSettings {
  /**
   * Typed requests go to the tool-using agent (search, read, prepare changes
   * for approval). Off: the earlier question-and-answer paths.
   */
  toolAgent: boolean;
}

export const DEFAULT_INBOX_AGENT_SETTINGS: InboxAgentSettings = { toolAgent: false };

/** The stored value, or the defaults for one that is missing or malformed. */
export function parseInboxAgentSettings(raw: string | null | undefined): InboxAgentSettings {
  if (!raw) return { ...DEFAULT_INBOX_AGENT_SETTINGS };
  try {
    const value = JSON.parse(raw) as Partial<InboxAgentSettings> | null;
    return { toolAgent: value?.toolAgent === true };
  } catch {
    return { ...DEFAULT_INBOX_AGENT_SETTINGS };
  }
}
