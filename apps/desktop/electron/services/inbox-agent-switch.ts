import { createLogger } from '@sarvinbox/core';

import { INBOX_AGENT_SETTINGS_KEY, parseInboxAgentSettings } from '../../src/config/inbox-agent-settings';

const logger = createLogger('inbox-agent');

/**
 * Whether typed Inbox Agent requests go to the tool-using agent: the user's
 * "Work with tools" switch (Settings > AI > Inbox Agent), or
 * SARVINBOX_AGENT_HARNESS=1 for development. Read on every request, so a
 * change takes effect with the next one. A setting that cannot be read means
 * the earlier paths, which change no mail on their own.
 */
export function inboxAgentToolsEnabled(read: (key: string) => string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SARVINBOX_AGENT_HARNESS === '1') return true;
  try { return parseInboxAgentSettings(read(INBOX_AGENT_SETTINGS_KEY)).toolAgent; }
  catch (error) {
    logger.warn(`Inbox Agent setting unreadable; using the earlier paths (${(error as Error)?.name ?? 'Error'}).`);
    return false;
  }
}
