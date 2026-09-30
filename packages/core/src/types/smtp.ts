// SMTP client interface for Sarv Inbox

/**
 * SMTP configuration
 */
export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean; // true for 465, false for other ports (STARTTLS)
  username: string;
  password: string; // ignored when authMethod === 'oauth2'
  authMethod?: 'password' | 'oauth2';
  /** OAuth provider id — lets the main process refresh tokens. */
  oauthProvider?: 'gmail' | 'microsoft' | 'yahoo' | 'sarv';
  /** Bearer access token — required when authMethod === 'oauth2'. */
  accessToken?: string;
  from?: string; // Default "from" address
  tlsOptions?: {
    rejectUnauthorized?: boolean;
  };
  /**
   * Opt-in escape hatch for servers with self-signed / untrusted certs.
   * Default (undefined/false) keeps TLS verification ON — disabling it exposes
   * credentials and mail to man-in-the-middle attacks, so it must be an explicit
   * per-account choice, never the default.
   */
  allowInsecureTLS?: boolean;
}

/**
 * Email to send
 */
export interface SendEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string; // Plain text body
  htmlBody?: string; // Optional HTML body
  inReplyTo?: string; // Message-ID of email being replied to
  references?: string[]; // References header for threading
  attachments?: SendAttachment[];
  /** Send AS this account (multi-account). When set and not the active account,
   *  the send routes to this account's SMTP client + outbox + Sent folder.
   *  Undefined = the active account (normal single-account send). */
  accountId?: string;
  /** Header From address (identity/alias) to send as WITHIN the chosen account.
   *  Overrides the MIME From header; the SMTP envelope sender stays the
   *  authenticated account (SPF-safe). Undefined = the account's default from. */
  from?: string;
  /** Request a read receipt (MDN): adds a Disposition-Notification-To header. */
  requestReadReceipt?: boolean;
  /** Remind the sender if nobody replies. Recorded only once the send succeeds. */
  followUp?: SendFollowUpRequest;
  /** OpenPGP choice made in compose. Applied by the main process's outgoing
   *  MIME transform; undefined = the account's defaults. */
  pgp?: SendPgpRequest;
}

/**
 * Per-message OpenPGP choice. `encrypt` fails the send (permanently) when a
 * recipient has no usable key — it is never silently downgraded to plaintext.
 */
export interface SendPgpRequest {
  encrypt: boolean;
  sign: boolean;
}

/** What an outgoing MIME transform knows about the message it rewrites. */
export interface OutgoingMimeContext {
  /** The header From actually used (identity/alias or the account default). */
  fromHeader: string;
  /** Every envelope recipient — to, cc AND bcc — each exactly as given. */
  recipients: string[];
}

/**
 * Rewrites the fully built MIME just before submission (e.g. PGP encryption).
 * The returned bytes are what is transmitted AND what is appended to Sent.
 * Throw an `OutgoingMimeError` to fail the send with an explicit retry class.
 */
export type OutgoingMimeTransform = (raw: Buffer, context: OutgoingMimeContext) => Promise<Buffer>;

/**
 * "Remind me if nobody replies". Unix epoch seconds (UTC). `afterSeconds`
 * counts from the moment the message actually goes out; `at` is a fixed time
 * and wins when both are set.
 */
export interface SendFollowUpRequest {
  afterSeconds?: number;
  at?: number;
}

/**
 * Attachment to send
 */
export interface SendAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
  encoding?: 'base64' | 'utf-8';
}

/**
 * Result of sending email
 */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /**
   * On failure: whether the error is transient (worth retrying via the outbox)
   * vs permanent. Undefined on success.
   */
  transient?: boolean;
  /**
   * On success: the exact raw MIME that was submitted to SMTP. Reused verbatim
   * to APPEND a copy into the IMAP Sent folder so the Message-ID matches (no
   * rebuild / drift). Undefined on failure.
   */
  rawMessage?: string;
  /**
   * On success: whether a client-side IMAP APPEND into the Sent folder is still
   * needed. False for providers that auto-file SMTP submissions into Sent
   * (Gmail) — appending there would create a duplicate. Set by the send path
   * that knows the provider (sendEmailFromMain), not the raw SMTP client.
   */
  needsSentAppend?: boolean;
}

/**
 * SMTP error
 */
export class SMTPError extends Error {
  constructor(
    message: string,
    public code: string,
    public serverResponse?: string
  ) {
    super(message);
    this.name = 'SMTPError';
  }
}
