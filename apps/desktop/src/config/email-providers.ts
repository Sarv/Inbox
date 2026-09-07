// Single source of truth for well-known email provider presets — used by the
// add-account wizard, onboarding IMAP step, and (optionally) the Accounts tab.
// One list avoids the host/port drift that previously existed between screens.
// Each preset covers BOTH incoming (IMAP) and sending (SMTP) so the wizard can
// prefill every step from a single pill. `oauthProviderId` links to an OAuth
// provider id from `window.electronAPI.oauth.listProviders()` when available.

export type ConnectionSecurity = 'ssl' | 'starttls' | 'none';

export interface EmailProviderPreset {
  id: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: ConnectionSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: ConnectionSecurity;
  /** OAuth provider id (matches oauth.listProviders ids) when the provider
   *  supports OAuth sign-in; absent for password-only providers. */
  oauthProviderId?: string;
}

export const EMAIL_PROVIDERS: EmailProviderPreset[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    oauthProviderId: 'gmail',
  },
  {
    id: 'outlook',
    name: 'Outlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    oauthProviderId: 'microsoft',
  },
  {
    id: 'yahoo',
    name: 'Yahoo',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    oauthProviderId: 'yahoo',
  },
  {
    id: 'sarv',
    name: 'Sarv',
    imapHost: 'imap.sarv.com',
    imapPort: 993,
    imapSecurity: 'ssl',
    smtpHost: 'smtp.sarv.com',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    // Surfaces the "Sign in with Sarv" OAuth button (XOAUTH2) on the Sarv pill,
    // with the manual app-password form still available as a fallback.
    oauthProviderId: 'sarv',
  },
];

/** Default port for a given connection security (IMAP vs SMTP differ). */
export function defaultPort(kind: 'imap' | 'smtp', security: ConnectionSecurity): number {
  if (kind === 'imap') return security === 'ssl' ? 993 : 143;
  return security === 'ssl' ? 465 : security === 'starttls' ? 587 : 25;
}
