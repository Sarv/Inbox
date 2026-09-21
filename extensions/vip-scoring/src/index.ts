/**
 * VIP Senders — Sarv Inbox extension.
 *
 * Learns who you actually deal with from your own mailbox — who you answer, who
 * you write to first, who writes to you alone rather than to a list — and tags
 * their incoming mail `vip` so it can be filtered, searched and pinned.
 *
 * There is no list to maintain and nothing leaves the machine: no AI, no
 * network permission, counts only, never content.
 *
 * Learning and acting are deliberately split. Learning listens to `email:synced`
 * because that event carries the folder, which is the only way to tell mail you
 * SENT from mail you received. Acting is a workflow, because that is what can
 * return labels for the message being processed.
 */

import type {
  EmailRecord,
  EmailSyncedEvent,
  ExtensionContext,
  ExtensionWorkflowResult,
} from '@sarvinbox/core/extension-sdk';

import { observationsFor } from './observe';
import { TABLE_KEY, createProfileStore, type ProfileStore } from './profile-store';
import { isVipSender, scoreRelationship } from './relationship';
import { isUnreachableSender, normalizeSenderKey } from './sender-key';

const WORKFLOW_ID = 'score-sender';

const SETTING_ENABLED = 'vip-scoring.enabled';
const SETTING_THRESHOLD = 'vip-scoring.threshold';
const SETTING_TAG = 'vip-scoring.tagVipMail';

/** Tag applied to incoming mail from a VIP sender. */
export const VIP_TAG = 'vip';

/** Used when the settings value is missing or out of range. */
export const DEFAULT_THRESHOLD = 0.6;

/** Clamp a configured threshold, ignoring anything unusable. */
export function resolveThreshold(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return DEFAULT_THRESHOLD;
  if (configured < 0 || configured > 1) return DEFAULT_THRESHOLD;
  return configured;
}

export function activate(context: ExtensionContext): void {
  const store: ProfileStore = createProfileStore({
    load: () => context.storage.get(TABLE_KEY),
    save: (table) => context.storage.set(TABLE_KEY, table),
    onError: (error) => context.log.error('Sender profile storage failed', error),
  });

  const isEnabled = (): boolean => context.settings.get<boolean>(SETTING_ENABLED, true) !== false;

  // --- Learning -----------------------------------------------------------
  // Only `isNew` messages are counted. `email:synced` also fires when an
  // existing message is re-synced (a flag changed, a folder was re-scanned);
  // counting those would inflate every counter by however many times the
  // mailbox has been swept, which is unbounded and invisible.
  context.events.on<EmailSyncedEvent>('email:synced', (event) => {
    if (!event.isNew || !isEnabled()) return;
    try {
      for (const { key, observation } of observationsFor(event.email, event.folder, event.timestamp)) {
        store.observe(key, observation);
      }
    } catch (error) {
      // Learning is best-effort: a malformed header must never break the sync
      // that delivered it.
      context.log.error('Failed to record sender observation', error);
    }
  });

  // --- Acting -------------------------------------------------------------
  context.registerWorkflow({
    id: WORKFLOW_ID,
    name: 'Score sender relationship',
    description: 'Ranks the sender against your own history and tags their mail',
    priority: 20,

    shouldProcess: (email: EmailRecord): boolean => isEnabled() && Boolean(email.fromAddress),

    process: async (email: EmailRecord): Promise<ExtensionWorkflowResult> => {
      try {
        // The table is read from disk once, at activation. Until that lands we
        // have nothing to say — and saying nothing is correct, because the
        // message will still be there to filter on afterwards.
        await store.ready;

        const key = normalizeSenderKey(email.fromAddress);
        if (!key || isUnreachableSender(key)) return { success: true };

        const profile = store.get(key);
        if (!profile) return { success: true };

        const now = Date.now();
        const threshold = resolveThreshold(context.settings.get<number>(SETTING_THRESHOLD));
        if (!isVipSender(profile, threshold, now)) return { success: true };

        const shouldTag = context.settings.get<boolean>(SETTING_TAG, true) !== false;

        return {
          success: true,
          ...(shouldTag ? { labelsToAdd: [VIP_TAG] } : {}),
          metadata: {
            score: scoreRelationship(profile, now),
            received: profile.received,
            replied: profile.replied,
            sent: profile.sent,
          },
        };
      } catch (error) {
        context.log.error('Sender scoring failed', error);
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  });

  // Whatever has been learned must reach disk when the app closes; the flush
  // timer alone would lose up to one interval of counters on every quit.
  context.subscriptions.push(() => {
    void store.dispose();
  });

  context.log.info('VIP Senders activated');
}

export function deactivate(): void {
  // The store's flush is registered as a subscription above; the host disposes
  // subscriptions on deactivate.
}
