import { BLOCKLISTS } from '@sarv-in/mailguard/reputation';
import { defaultBlocklistPrefs, type BlocklistPrefs } from '@sarvinbox/core/blocklist-prefs';

import type { InboxType, InboxSection } from '../../config/inbox-types';

export type SettingsTab = 'general' | 'inbox' | 'accounts' | 'folders' | 'filters' | 'advanced' | 'keyboard-shortcuts';

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
  conversationView: boolean;
  previewPane: 'off' | 'right' | 'bottom';
  markAsReadDelay: number;
  /** How received-mail remote images are loaded (privacy vs. convenience —
   *  remote images are the tracking-pixel vector):
   *   - 'block'  : always block behind the "Load images" banner
   *   - 'safe'   : auto-load ONLY for AI-categorized mail that isn't Promotional
   *                or Spam; uncategorized/Promo/Spam stay behind the banner
   *   - 'always' : auto-load everywhere
   *  New installs default to 'safe'. Legacy 'important' migrates to 'safe'. */
  remoteImageMode: 'block' | 'safe' | 'always';
  /** Show the sender domain's BIMI brand logo as the avatar (DMARC-passing
   *  mail only), and the blue verified tick when its Verified Mark
   *  Certificate checks out. One DNS lookup plus one fetch from the brand's
   *  own server per domain, in the background, in the main process. */
  senderLogos: boolean;
  /** When a sender has no photo or logo, use the domain's favicon. One fetch
   *  per domain, which tells that domain a client here looked, once. */
  senderFavicons: boolean;
  /** The spam filter's reputation stage: who is asked about sender IPs and
   *  domains after a message arrives. 'sarv' = the Sarv-hosted service (needs
   *  its endpoint; nothing happens until it is set), 'local' = DNS blocklists
   *  queried from this machine (Spamhaus and URIBL refuse public resolvers),
   *  'off' = judge from headers only. */
  spamReputationMode: 'off' | 'local' | 'sarv';
  /** Origin of the Sarv reputation service, e.g. https://reputation.sarv.com. */
  spamReputationEndpoint: string;
  /** Send your own Report spam / Not spam verdicts (sender domain, server address,
   *  verdict — never subject, body or recipients) to the Sarv service so they
   *  count for other users. Opt-in. */
  spamReputationReports: boolean;
  /** Ask the domain registry (RDAP) how recently the sender's and the linked
   *  domains were registered — a five-day-old domain is the tell no blocklist
   *  has yet. On by default; nothing is asked when the stage is off. */
  spamReputationDomainAge: boolean;

  /** Mirror AI categories onto the mail server as labels (visible in Gmail /
   *  sarv webmail / other clients). `folderMode` only applies to providers that
   *  have no labels/keywords (Outlook, Yahoo, …): copy = keep in Inbox + a
   *  duplicate in the folder; move = file it into the folder (leaves Inbox).
   *  Gmail (labels) and sarv (keywords) keep mail in the Inbox with no dupe. */
  categoryLabels: { enabled: boolean; folderMode: 'copy' | 'move' };

  /** Blocklist (DNSBL) lookups during the spam scan. OFF by default and
   *  deliberately: it is the only check that leaves the machine, telling a
   *  third-party operator in real time which addresses are writing to this
   *  user. `zones` names entries from the scanner's catalogue; `servers` are
   *  the resolvers to ask, which matters because the large operators refuse
   *  queries arriving through a public or open resolver — the default on most
   *  home connections. Absent means never configured, which reads as off. */
  reputation?: BlocklistPrefs;

  // Inbox settings
  inboxType: InboxType;
  showImportanceMarkers: boolean;
  inboxSections: InboxSection[];

  // Compose settings
  undoSendDelay: number;
  defaultReplyBehavior: 'reply' | 'replyAll';

  // UI settings
  hoverActions: boolean;
  keyboardShortcuts: boolean;
  buttonLabels: 'icons' | 'text' | 'both';

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
  conversationView: true,
  previewPane: 'right',
  markAsReadDelay: 3,
  remoteImageMode: 'safe',
  senderLogos: true,
  senderFavicons: true,
  spamReputationMode: 'sarv',
  spamReputationEndpoint: '',
  spamReputationReports: false,
  spamReputationDomainAge: true,
  categoryLabels: { enabled: true, folderMode: 'copy' },
  reputation: defaultBlocklistPrefs(BLOCKLISTS.map((list) => list.name)),
  inboxType: 'priority_first',
  showImportanceMarkers: true,
  inboxSections: [],
  undoSendDelay: 5,
  defaultReplyBehavior: 'reply',
  hoverActions: true,
  keyboardShortcuts: true,
  buttonLabels: 'icons',
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
    id: 'email-categorization',
    name: 'Smart Email Categorization',
    description: 'Automatically categorize emails into Reminders, Needs Response, Meetings, Invoices, and Promotions based on content and context.',
    enabled: true,
    systemPrompt: '',
    userPrompt: '',
  },
  {
    id: 'conversation-mode',
    name: 'AI Conversation Mode',
    description: 'Extract individual messages from quoted/forwarded email content for a unified conversation view.',
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
    description: 'Automatically open threads in Chat View and extract conversations. Off by default — open normally, then switch to Chat View when you want it.',
    enabled: false,
    systemPrompt: '',
    userPrompt: '',
  },
  {
    id: 'auto-chat-extract',
    name: 'Auto Chat Extract',
    description: 'Automatically extract conversations in the background when new emails arrive. Threads will be pre-processed so chat view loads instantly.',
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
