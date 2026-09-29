/**
 * The chat view's three AI feature toggles, read from the stored AI features.
 *
 * Their own module so the chat view, the first-email split, its background
 * job and the settings tab read one definition of each switch.
 *
 *   * `conversation-mode` — the chat view's AI mode at all. ON unless the
 *     user switched it off.
 *   * `auto-chat-view` — open threads in the chat view by themselves.
 *   * `auto-chat-extract` — pre-split, in the background, the first email of
 *     threads whose first email quotes two or more earlier messages.
 */
import { loadAIFeatures } from './ai-service';

function featureEnabled(id: string): boolean | undefined {
  return loadAIFeatures().find((feature) => feature.id === id)?.enabled;
}

export function isConversationModeEnabled(): boolean {
  return featureEnabled('conversation-mode') !== false;
}

export function isAutoChatViewEnabled(): boolean {
  return featureEnabled('auto-chat-view') === true;
}

export function isAutoChatExtractEnabled(): boolean {
  return featureEnabled('auto-chat-extract') === true;
}

/** The background first-email split's own switch: conversation mode AND 'Auto Chat Extract'. */
export function isBackgroundSplitEnabled(): boolean {
  return isConversationModeEnabled() && isAutoChatExtractEnabled();
}

/**
 * Tell main's nomination scheduler whether the background split is switched
 * on, so it neither scans the account databases nor nominates while it is
 * off. Call on startup and after every change to either toggle.
 * Best effort: without a bridge, or when the call fails, main keeps its last
 * value (off at launch).
 */
export async function syncBackgroundSplitToMain(): Promise<void> {
  // `globalThis.window`: undefined (not a ReferenceError) where there is no DOM.
  const ai = (globalThis as { window?: Window }).window?.electronAPI?.ai;
  try {
    await ai?.setBackgroundSplitEnabled?.(isBackgroundSplitEnabled());
  } catch { /* best effort — see above */ }
}
