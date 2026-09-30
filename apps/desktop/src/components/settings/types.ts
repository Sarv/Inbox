import type { BlocklistPrefs } from '@sarvinbox/core/blocklist-prefs';
import { DEFAULT_SENDER_IDENTITY_POLICY } from '@sarvinbox/core/sender-identity-policy';

import type { InboxType, InboxSection } from '../../config/inbox-types';
import type { RemoteImageMode } from '../../utils/remote-images';

export type SettingsTab = 'general' | 'appearance' | 'inbox' | 'accounts' | 'folders' | 'filters' | 'advanced' | 'keyboard-shortcuts';

/** A named email signature. `html` is stored verbatim (never round-tripped
 *  through a rich-text schema) so pasted table/flex layouts stay pixel-faithful. */
export interface EmailSignature {
  id: string;
  name: string;
  html: string;
}

export interface AppSettings {
  // Sync settings
  maxEmailsPerFolder: number;
  maxAIProcessingEmails: number;
  bodyDownloadLimit: number;

  // Display settings
  emailsPerPage: number;
  markAsReadDelay: number;
  /** How received-mail remote images are loaded (privacy vs. convenience —
   *  remote images are the tracking-pixel vector). Two independent sources —
   *  trusted senders ("Trust this sender", people you've emailed, verified
   *  brands; never in Spam or when the message failed authentication) and
   *  AI-categorized mail that isn't Promotional, Social or Spam — held in one
   *  value:
   *   - 'block'       : neither; everything waits for "Load images"
   *   - 'trusted'     : trusted senders only
   *   - 'categorized' : categorized mail only
   *   - 'safe'        : both (the default)
   *   - 'always'      : auto-load everywhere
   *  The reader's explicit allowlist applies in every mode. Legacy 'important'
   *  migrates to 'safe'. Translated to and from the two switches only by
   *  utils/remote-images.ts `remoteImageSourcesOf` / `remoteImageModeFor`; the
   *  one decision is `shouldAutoLoadRemoteImages` there.
   *  Chosen ONLY under Security → Remote images (`saveRemoteImageMode`); a
   *  settings screen's Save never writes its copy back (utils/app-settings.ts
   *  `SETTINGS_OWNED_ELSEWHERE`). */
  remoteImageMode: RemoteImageMode;
  /** Show the sender domain's BIMI brand logo as the avatar (DMARC-passing
   *  mail only), and the blue verified tick when its Verified Mark
   *  Certificate checks out. One DNS lookup plus one fetch from the brand's
   *  own server per domain, in the background, in the main process. */
  senderLogos: boolean;
  /** When a sender has no photo or logo, use the domain's favicon. One fetch
   *  per domain, which tells that domain a client here looked, once. */
  senderFavicons: boolean;
  /** Ask Gravatar for contacts' photos (sends Gravatar an MD5 hash of each
   *  contact's address — which Gravatar, and anyone with a list of addresses,
   *  can match back to it). On unless the user turns it off: only an explicit
   *  `false` is off, a missing value is on (core `senderIdentityPolicyFromSettings`).
   *  Opt-in in 1.2.6; on by default since 2026-09-30. */
  contactGravatar: boolean;
  /** Send crash and error reports (addresses removed) so bugs can be fixed.
   *  On unless the user turns it off. */
  crashReports: boolean;
  /** Mirror AI categories onto the mail server as labels (visible in Gmail /
   *  sarv webmail / other clients). `folderMode` only applies to providers that
   *  have no labels/keywords (Outlook, Yahoo, …): copy = keep in Inbox + a
   *  duplicate in the folder; move = file it into the folder (leaves Inbox).
   *  Gmail (labels) and sarv (keywords) keep mail in the Inbox with no dupe. */
  categoryLabels: { enabled: boolean; folderMode: 'copy' | 'move' };

  /** Who is asked about incoming mail — blocklists through this computer's DNS
   *  or the Sarv service, link lookups, registration dates — the ONE setting
   *  for the reputation checks, the only ones that leave the machine. Written
   *  only by Security > Blocklists (with `chosen`) and read only through
   *  core's `readBlocklistPrefs`, which also migrates the retired
   *  `spamReputationMode` / `spamReputationEndpoint` / `spamReputationReports`
   *  / `spamReputationDomainAge` fields older builds left beside it. Absent
   *  from the defaults on purpose: a default section written by the Settings
   *  screen's save would look like a choice and hide those older fields. */
  reputation?: BlocklistPrefs;

  // Inbox settings
  inboxType: InboxType;
  showImportanceMarkers: boolean;
  inboxSections: InboxSection[];

  // Compose settings
  undoSendDelay: number;
  defaultReplyBehavior: 'reply' | 'replyAll';
  /** Ask before sending a message that mentions an attachment but has none. */
  attachmentReminder: boolean;

  // UI settings
  keyboardShortcuts: boolean;

  // Notifications
  desktopNotifications: 'all' | 'important' | 'off';
  notificationSound: boolean;
  /** Working-hours schedule for notification SOUND. Inside the window, new-mail
   *  notifications play a sound; outside it they still show but stay silent.
   *  days: 0=Sun … 6=Sat; start/end: "HH:MM" (local time). */
  notificationWorkingHours: { enabled: boolean; days: number[]; start: string; end: string };

  // Signature
  signatureEnabled: boolean;
  /** Legacy single signature — migrated into `signatures` on load, kept for
   *  backward compatibility with older stored settings. */
  signature: string;
  /** Named signatures the user can pick between (Gmail-style). */
  signatures: EmailSignature[];
  /** Signature id used for new emails ('' = none). */
  defaultSignatureNew: string;
  /** Signature id used on reply/forward ('' = none). */
  defaultSignatureReply: string;
  /** Per-account signature overrides: accountId -> { new, reply } signature ids.
   *  Absent/empty falls back to the global defaults above. Lets each account
   *  (e.g. Gmail vs Sarv) use its own signature. */
  accountSignatures?: Record<string, { new?: string; reply?: string }>;

  // Account/Profile
  profileName: string;
  profileTitle: string;
  profileCompany: string;
  profileEmail: string;
  profilePhone: string;
}

export const defaultSettings: AppSettings = {
  maxEmailsPerFolder: 1000,
  maxAIProcessingEmails: 500,
  bodyDownloadLimit: 1000,
  emailsPerPage: 25,
  markAsReadDelay: 3,
  remoteImageMode: 'safe',
  // The picture lookups' defaults are core's, shared with main's fallback.
  senderLogos: DEFAULT_SENDER_IDENTITY_POLICY.logos,
  senderFavicons: DEFAULT_SENDER_IDENTITY_POLICY.favicons,
  contactGravatar: DEFAULT_SENDER_IDENTITY_POLICY.gravatar,
  crashReports: true,
  categoryLabels: { enabled: true, folderMode: 'copy' },
  inboxType: 'priority_first',
  showImportanceMarkers: true,
  inboxSections: [],
  undoSendDelay: 5,
  defaultReplyBehavior: 'reply',
  attachmentReminder: true,
  keyboardShortcuts: true,
  // Default to AI-important-only: 'all' on a busy mailbox is instant fatigue.
  desktopNotifications: 'important',
  notificationSound: true,
  notificationWorkingHours: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  signatureEnabled: false,
  signature: '',
  signatures: [],
  defaultSignatureNew: '',
  defaultSignatureReply: '',
  profileName: '',
  profileTitle: '',
  profileCompany: '',
  profileEmail: '',
  profilePhone: '',
};

// Signature pattern type (from preload)
export interface SignaturePattern {
  id: string;
  email: string;
  htmlSelector: string;
  sampleHtml: string | null;
  emailIds: string[];
  confidence: 'high' | 'medium' | 'low';
  usageCount: number;
  lastUsed: number;
  createdAt: number;
}

// AI Feature configuration interface
export interface AIFeatureConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  systemPrompt: string;
  userPrompt: string;
}

// Default AI Features with their prompts
export const DEFAULT_AI_FEATURES: AIFeatureConfig[] = [
  {
    id: 'signature-detection',
    name: 'Auto Signature Detection',
    description: 'Detect email signatures by identifying the HTML element that contains them. This allows parsing signatures in email threads with multiple replies.',
    enabled: true,
    systemPrompt: `You are an email signature detection assistant. Analyze email HTML and return a CSS selector for the signature element.

IMPORTANT: You MUST return "htmlSelector" field with a valid CSS selector string. Do NOT return signatureStartIndex or any index-based response.

Common signature CSS selectors:
- Gmail: "div.gmail_signature" or "div[class*='gmail_signature']"
- Outlook: "#Signature" or "#signature" or "div[id*='signature']"
- Apple Mail: "div.signature" or "div[class*='signature']"
- Corporate: "table[class*='sig']" or "table[class*='signature']"
- Generic: "div[class*='sig']" or "div[id*='sig']" or "div.footer"

REQUIRED JSON format (use exactly these field names):
{
  "hasSignature": true or false,
  "htmlSelector": "CSS selector like div.gmail_signature or #Signature or null if no signature",
  "sampleHtml": "Copy the HTML of the signature element here or null",
  "signatureText": "Plain text of the signature or null",
  "confidence": "high" or "medium" or "low"
}

CRITICAL: The "htmlSelector" field must be a CSS selector string (like "div.gmail_signature"), NOT an index number.`,
    userPrompt: 'Find the signature in this email HTML. Return a JSON with "htmlSelector" containing a CSS selector (like "div.gmail_signature" or "#Signature") that matches the signature element. Do NOT return an index.',
  },
  {
    id: 'conversation-mode',
    name: 'AI Conversation Mode',
    // The chat view's AI half: Standard's bubbles, with ONLY the thread's first
    // email split by AI (its quoted history is where a looped-in reader's
    // earlier conversation lives). Off also stops auto-open and the background split.
    description: 'Add an AI view to Chat View. When you were looped in partway through, AI splits the earlier conversation quoted in the first email into separate messages. Every other email is shown as in the standard view.',
    enabled: true,
    systemPrompt: '',
    userPrompt: '',
  },
  {
    id: 'auto-chat-view',
    // Opt-in: threads open in the normal reading view by default; the user
    // switches to Chat View with the List/Chat toggle. Enable this to have
    // threads auto-open in Chat View instead.
    name: 'Auto Chat View',
    description: 'Open conversations in Chat View by themselves, including a single looped-in email that quotes two or more earlier messages. Off by default: threads open in the normal reading view, and the List/Chat toggle switches them.',
    enabled: false,
    systemPrompt: '',
    userPrompt: '',
  },
  {
    id: 'auto-chat-extract',
    name: 'Auto Chat Extract',
    // Background pre-split of FIRST emails that quote two or more earlier
    // messages, across every account; never a whole thread, never later mail.
    description: 'Prepare the AI view in the background: when a thread\'s first email quotes two or more earlier messages, split it before you open it, in every account.',
    enabled: true,
    systemPrompt: '',
    userPrompt: '',
  },
];

export const AI_FEATURES_KEY = 'sarvinbox-ai-features';

// Shared props for tab components
export interface SettingsTabProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

// Spammer record
export interface SpammerRecord {
  id?: string;
  email: string;
  domain?: string | null;
  name?: string | null;
  reason?: string | null;
  reportedCount: number;
  firstReportedAt: number;
  lastReportedAt: number;
}
