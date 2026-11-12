import { useEffect, useState } from 'react';

interface AssistantShortcutGateOptions {
  onboarding: boolean;
  /** The app section on screen ('assistant' is the full chat). */
  section: string;
  /** The cited email open beside the full chat, if any. */
  source: unknown;
}

/**
 * Whether Mail's single-key shortcuts (d = Trash, e = Archive, r = Reply) are
 * armed while the Inbox Agent is on screen.
 *
 * They are off whenever the chat was the surface used last, which
 * `AssistantWorkspace` reports through `setAssistantFocused`. That covers the
 * split and floating views, and the full chat with a cited email open beside
 * it: a chat control that drops focus to <body> must not turn the next words
 * of a follow-up into mail commands on the open email.
 */
export function useAssistantShortcutGate({ onboarding, section, source }: AssistantShortcutGateOptions) {
  const [assistantFocused, setAssistantFocused] = useState(false);
  // In the full chat a cited email opens beside it as a mail surface. Opening
  // one hands the keyboard to that email (reply, next) until the chat is used
  // again; without this the click on the citation would count as chat use.
  useEffect(() => { if (source && section === 'assistant') setAssistantFocused(false); }, [source, section]);
  return {
    setAssistantFocused,
    enabled: !onboarding && !assistantFocused && (section !== 'assistant' || !!source),
    allowListNavigation: section !== 'assistant' && !assistantFocused,
  };
}
