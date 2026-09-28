import { useMemo } from 'react';

import { assessEmailSecurity, type SecurityAssessment } from './email-security';
import { useLinkRules } from './security-rules';
import { useTrustedSenders } from './trusted-senders';

type AssessmentInput = Omit<Parameters<typeof assessEmailSecurity>[0], 'rules' | 'trustedSender'>;

/**
 * `assessEmailSecurity` against the reader's live trust/block rules and the
 * senders they trust, re-run when any of them changes. The single way a component asks "how safe is this
 * message", so the shield, the warning banner and anything that hides itself
 * on risky mail always read the same level.
 */
export function useEmailSecurity(input: AssessmentInput): SecurityAssessment {
  const { sets } = useLinkRules();
  const trustedSender = useTrustedSenders().isTrusted(input.fromAddress);
  const { fromName, fromAddress, html, bodyLoaded, authStatus, spamScore, spamReasons, bimi } = input;
  const hasBimi = 'bimi' in input;
  return useMemo(
    () =>
      assessEmailSecurity({
        fromName, fromAddress, html, bodyLoaded, authStatus, spamScore, spamReasons, rules: sets, trustedSender,
        // Passing `bimi: undefined` is not the same as omitting it — the
        // library reads a present key as "the brand lookup has answered".
        ...(hasBimi ? { bimi } : {}),
      }),
    [fromName, fromAddress, html, bodyLoaded, authStatus, spamScore, spamReasons, bimi, hasBimi, sets, trustedSender],
  );
}
