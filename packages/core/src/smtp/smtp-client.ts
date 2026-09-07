// SMTP client for sending emails

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';

import type { SMTPConfig, SendEmailOptions, SendResult } from '../types/smtp';
import { createLogger } from '../utils/logger';
import { resolveTlsOptions } from '../utils/tls';
import { isValidEmail, extractEmailAddress } from '../utils/validators';

const logger = createLogger('SMTPClient');

import { isTransientSendError } from './smtp-errors';

/**
 * Extract the bare email address from a "Display Name <addr@host>" string (or
 * return it unchanged if it's already bare). Used only for the SMTP envelope's
 * MAIL FROM — the human-readable From header is preserved verbatim in the MIME.
 */
function bareAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

/**
 * Generate a stable RFC-5322 Message-ID we control, so the exact same value
 * lands in the transmitted message AND in the Sent-folder copy we APPEND.
 */
function generateMessageId(fromAddress: string): string {
  const domain = bareAddress(fromAddress).split('@')[1] || 'sarvinbox.local';
  return `<${Date.now()}.${Math.random().toString(36).slice(2, 12)}@${domain}>`;
}

/**
 * SMTP client for sending emails
 */
export class SMTPClient {
  private transporter: Transporter | null = null;
  private config: SMTPConfig | null = null;

  /**
   * Connect to SMTP server
   */
  async connect(config: SMTPConfig): Promise<void> {
    logger.info('[SMTPClient] Connecting to SMTP server:', config.host);

    // This client is a reused singleton — smtp:connect re-calls connect() on
    // every (re)auth / token refresh. Close the previous transporter before
    // replacing it so we don't abandon the old one (and any socket it holds).
    if (this.transporter) {
      try {
        this.transporter.close();
      } catch {
        // Already closed / never fully opened — nothing to release.
      }
      this.transporter = null;
    }

    this.config = config;

    const auth = config.authMethod === 'oauth2'
      ? (() => {
          if (!config.accessToken) {
            throw new Error('OAuth2 auth requested but accessToken missing');
          }
          return {
            type: 'OAuth2' as const,
            user: config.username,
            accessToken: config.accessToken,
          };
        })()
      : {
          user: config.username,
          pass: config.password,
        };

    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // On a non-implicit-TLS connection (STARTTLS, e.g. port 587), REQUIRE the
      // STARTTLS upgrade so the session can never silently fall back to sending
      // credentials/mail in cleartext. Skipped only if the account explicitly
      // opted into insecure TLS. No-op when `secure` (implicit TLS on 465/993).
      requireTLS: !config.secure && !config.allowInsecureTLS,
      auth: auth as any,
      // TLS verification ON by default + TLS 1.2 floor (see resolveTlsOptions).
      tls: resolveTlsOptions(config),
    });

    // Verify connection
    try {
      await this.transporter.verify();
      logger.info('[SMTPClient] Connected and verified');
    } catch (error) {
      logger.error('[SMTPClient] Connection failed:', error);
      this.transporter = null;
      this.config = null;
      throw error;
    }
  }

  /**
   * Disconnect from SMTP server
   */
  async disconnect(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
      this.config = null;
      logger.info('[SMTPClient] Disconnected');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.transporter !== null;
  }

  /**
   * The config this client last connected with (null until connected). Exposed so
   * the send path can reconnect with a freshly-refreshed OAuth token after a
   * token-expired failure — the transporter caches the token it connected with
   * and nodemailer (static accessToken) never refreshes it on its own.
   */
  getConfig(): SMTPConfig | null {
    return this.config;
  }

  /**
   * Send an email
   */
  async sendEmail(options: SendEmailOptions): Promise<SendResult> {
    if (!this.transporter || !this.config) {
      // Not connected is transient: the outbox should hold this and retry once
      // the renderer re-establishes the SMTP connection.
      return {
        success: false,
        error: 'Not connected to SMTP server',
        transient: true,
      };
    }

    // Validate every recipient address before handing off to nodemailer. A
    // malformed/injected recipient is a permanent (non-transient) error — retrying
    // it in the outbox would just fail forever — so fail fast and clearly.
    const allRecipients = [
      ...options.to,
      ...(options.cc ?? []),
      ...(options.bcc ?? []),
    ];
    if (allRecipients.length === 0) {
      return { success: false, error: 'No recipients specified', transient: false };
    }
    // Validate the ADDRESS part — recipients legitimately carry a display name
    // ("Accounts Sarv <accounts@sarv.com>"), which nodemailer sends fine but the
    // bare-email check would otherwise reject as an invalid recipient.
    const invalid = allRecipients.filter((addr) => !isValidEmail(extractEmailAddress(addr)));
    if (invalid.length > 0) {
      return {
        success: false,
        error: `Invalid recipient address(es): ${invalid.join(', ')}`,
        transient: false,
      };
    }

    try {
      logger.info('[SMTPClient] Sending email to:', options.to.join(', '));

      // Header From: a chosen identity/alias (options.from) wins, else the
      // account default. The SMTP envelope sender stays the AUTHENTICATED account
      // (below) so aliases don't trip SPF / server "MAIL FROM must match" rules.
      const fromHeader = options.from || this.config.from || this.config.username;
      // Stamp our OWN Message-ID so the transmitted message and the Sent-folder
      // copy we later APPEND carry the identical id (dedupe + reconcile depend
      // on it). MailComposer would otherwise generate one we can't predict.
      const messageId = generateMessageId(fromHeader);

      // Build the message ONCE with MailComposer, then submit that exact MIME to
      // SMTP and reuse the same bytes for the Sent APPEND — no second build, no
      // header/boundary drift. Bcc is deliberately kept OUT of the MIME (it must
      // never be transmitted or saved to Sent); Bcc recipients are delivered via
      // the explicit SMTP envelope below.
      const composerOptions: Record<string, unknown> = {
        from: fromHeader,
        to: options.to.join(', '),
        subject: options.subject,
        messageId,
        date: new Date(),
      };
      // Read receipt (MDN): ask the recipient's client to notify this sender.
      if (options.requestReadReceipt) {
        composerOptions.headers = { 'Disposition-Notification-To': fromHeader };
      }
      if (options.cc && options.cc.length > 0) composerOptions.cc = options.cc.join(', ');
      if (options.htmlBody) composerOptions.html = options.htmlBody;
      if (options.body) composerOptions.text = options.body;
      if (options.inReplyTo) {
        composerOptions.inReplyTo = options.inReplyTo;
        composerOptions.references = options.references?.join(' ') || options.inReplyTo;
      }
      if (options.attachments && options.attachments.length > 0) {
        composerOptions.attachments = options.attachments.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
          encoding: att.encoding as BufferEncoding | undefined,
        }));
      }

      const rawMessage = await new Promise<Buffer>((resolve, reject) => {
        new MailComposer(composerOptions as any).compile().build((err: Error | null, message: Buffer) => {
          if (err) reject(err);
          else resolve(message);
        });
      });

      // Deliver the prebuilt MIME. The explicit envelope carries every recipient
      // (to + cc + bcc) so Bcc still gets the mail even though its header isn't
      // in the message body.
      const result = await this.transporter.sendMail({
        envelope: {
          // Envelope sender = the AUTHENTICATED account (not the alias header
          // From) so alias sends pass SPF / server MAIL-FROM checks.
          from: bareAddress(this.config.username || fromHeader),
          to: [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])],
        },
        raw: rawMessage,
      });

      logger.info('[SMTPClient] Email sent, messageId:', messageId, '(smtp:', result.messageId, ')');

      return {
        success: true,
        messageId,
        rawMessage: rawMessage.toString('utf-8'),
      };
    } catch (error) {
      logger.error('[SMTPClient] Failed to send email:', error);
      return {
        success: false,
        error: (error as Error).message,
        transient: isTransientSendError(error),
      };
    }
  }
}

// Export singleton instance for convenience
export const smtpClient = new SMTPClient();
