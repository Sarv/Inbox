// The user's answer to "Let Sarv AI read your new mail?".
//
// Sarv AI processes mail automatically (sorting, drafts, conversation
// extraction), so it must never switch itself on from a sign-in alone: mail
// from a connected Gmail account is Google user data, and Google's policy — and
// our privacy policy — require the user's explicit agreement before it goes to
// an AI service. Nothing is sent to an AI provider until one is registered, so
// gating the Sarv registration on this answer gates the data flow.

import { aiEndpointHost } from '@sarvinbox/core/ai-provider-auth';

import { requestConfirm } from '../store/confirm-service';

const KEY = 'sarvinbox-ai-consent';

export type AiConsent = 'granted' | 'declined';

/** The stored answer, or null when the user has never been asked. */
export function getAiConsent(): AiConsent | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'granted' || v === 'declined' ? v : null;
  } catch {
    return null;
  }
}

export function setAiConsent(value: AiConsent): void {
  try {
    localStorage.setItem(KEY, value);
  } catch { /* storage unavailable: the user is simply asked again next time */ }
}

/** The disclosure shown wherever the user turns Sarv AI on. */
export const SARV_AI_DISCLOSURE =
  'Sarv AI sorts your inbox, drafts replies and pulls out conversations by sending new messages — sender, ' +
  'recipients, subject and text — to Sarv AI as they arrive, for every connected account. Sarv does not use ' +
  'your mail to train AI models. You can turn this off at any time in AI → Email Agent.';

/**
 * The disclosure shown when the user connects any other provider. Like Sarv's,
 * it says that new messages go to the provider as they arrive — connecting a
 * provider turns sorting on. For a custom provider, whose name the user typed,
 * it also names the server the mail actually goes to (`endpoint`'s host).
 */
export function providerAIDisclosure(name: string, endpoint?: string): string {
  const host = aiEndpointHost(endpoint);
  const destination = host && host !== name ? `${name} (${host})` : name;
  return 'AI sorts your inbox, drafts replies and pulls out conversations by sending new messages — sender, ' +
    `recipients, subject and text — to ${destination} as they arrive, for every connected account. Your ` +
    "provider's terms and data policy apply. You can turn this off at any time in AI → Email Agent.";
}

/**
 * Ask once. Resolves to the recorded answer; "Not now", Escape and a backdrop
 * click all record `declined`, so the user isn't asked on every launch — they
 * can still turn Sarv AI on later by choosing a model in AI → Providers.
 */
export async function askAiConsent(): Promise<AiConsent> {
  const yes = await requestConfirm({
    title: 'Let Sarv AI read your new mail?',
    message: SARV_AI_DISCLOSURE,
    confirmLabel: 'Turn on Sarv AI',
    cancelLabel: 'Not now',
    destructive: false,
  });
  const answer: AiConsent = yes ? 'granted' : 'declined';
  setAiConsent(answer);
  return answer;
}
