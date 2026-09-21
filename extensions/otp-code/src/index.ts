/**
 * One-Time Passcodes — Sarv Inbox extension.
 *
 * Reads the subject and body of arriving mail, finds a verification code, and
 * asks the app to show it on a card with a copy button and a countdown. Also
 * tags the mail `otp` so the codes stay findable after the card is gone.
 *
 * This file is the wiring only. Every decision worth testing lives in
 * `otp-detect.ts` (does this text contain a code?) and `otp-notification.ts`
 * (is it worth showing, and what does the card say?).
 */

import type {
  EmailRecord,
  ExtensionContext,
  ExtensionWorkflowResult,
} from '@sarvinbox/core';

import { MIN_CONFIDENCE, detectOtpCode } from './otp-detect';
import { OTP_TAG, buildOtpNotification, isFreshEnoughToNotify } from './otp-notification';

const WORKFLOW_ID = 'detect-code';

const SETTING_ENABLED = 'otp-code.enabled';
const SETTING_TAG_EMAILS = 'otp-code.tagEmails';
const SETTING_MIN_CONFIDENCE = 'otp-code.minConfidence';

/**
 * Codes already shown, so the body-stage re-run does not restart a countdown
 * that is already ticking on screen.
 *
 * The workflow runs twice per message — once on arrival (headers only) and
 * again once the body has been fetched — because a code in the subject should
 * surface without waiting for a download. Bounded because this map lives for
 * the life of the process; the cap is far above any plausible burst of codes
 * and eviction is oldest-first.
 */
const MAX_TRACKED_EMAILS = 500;

function rememberShown(shown: Map<string, string>, emailId: string, code: string): void {
  shown.set(emailId, code);
  while (shown.size > MAX_TRACKED_EMAILS) {
    const oldest = shown.keys().next();
    if (oldest.done) break;
    shown.delete(oldest.value);
  }
}

/** Resolve the confidence floor, ignoring a setting that is missing or out of range. */
export function resolveMinConfidence(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) return MIN_CONFIDENCE;
  if (configured < 0 || configured > 1) return MIN_CONFIDENCE;
  return configured;
}

export function activate(context: ExtensionContext): void {
  const shown = new Map<string, string>();

  context.registerWorkflow({
    id: WORKFLOW_ID,
    name: 'Detect one-time passcodes',
    description: 'Finds a verification code in the subject or body and surfaces it',
    priority: 10,
    // Subject-only codes surface on arrival; the rest need the body, which is
    // fetched after the message is stored.
    requiresBody: true,

    shouldProcess: (email: EmailRecord): boolean => {
      if (context.settings.get<boolean>(SETTING_ENABLED, true) === false) return false;
      // Nothing to read yet and nothing in the subject is cheap to rule out.
      return Boolean(email.subject || email.cleanBody);
    },

    process: async (email: EmailRecord): Promise<ExtensionWorkflowResult> => {
      try {
        const detection = detectOtpCode({ subject: email.subject, body: email.cleanBody });
        if (!detection) return { success: true };

        const floor = resolveMinConfidence(context.settings.get<number>(SETTING_MIN_CONFIDENCE));
        if (detection.confidence < floor) return { success: true };

        const alreadyShown = shown.get(email.id);
        if (alreadyShown !== detection.code && isFreshEnoughToNotify(email)) {
          context.ui.notify(buildOtpNotification(email, detection));
          rememberShown(shown, email.id, detection.code);
        }

        const tagEmails = context.settings.get<boolean>(SETTING_TAG_EMAILS, true) !== false;

        return {
          success: true,
          ...(tagEmails ? { labelsToAdd: [OTP_TAG] } : {}),
          metadata: {
            confidence: detection.confidence,
            source: detection.source,
            expiryFromMail: detection.expiryFromMail,
          },
        };
      } catch (error) {
        // A detector fault must never stop the mail being stored or the rest of
        // the pipeline running — report it and let the message through.
        context.log.error('OTP detection failed', error);
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  });

  context.log.info('One-Time Passcodes activated');
}

export function deactivate(): void {
  // Workflows are unregistered by the host; nothing else is held open.
}
