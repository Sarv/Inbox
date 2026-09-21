// Core utilities

export * from './id';
export * from './logger';
export * from './validators';
export * from './provider';
export * from './oauth-imap-presets';
export * from './gmail-labels';
export * from './role-address';
export * from './timeout';
export * from './deferred-fetch-error';
export * from './event-loop';
export * from './flush-scheduler';
export * from './byte-budget';
export * from './db-compaction';
export * from './folder-counts';
export * from './folder-drift';
export * from './sync-watermark';
export * from './stale-flags';
export * from './format-bytes';
export * from './log-aggregator';
export * from './tags';
export * from './tls';
export * from './filters';
export * from './ai-error';
export * from './calendar';
export * from './email-address';
export * from './attachment-kind';
export * from './bulk-mail';
export * from './safe-path';
export * from './mail-parse';
export * from './html-text';
export * from './quoted-text';
export * from './sarv-api-error';
export * from './cid-images';
export * from './inline-images';
export * from './remote-image-requests';
export * from './lru-cache';
export * from './ai-categories';
export * from './single-flight';
export * from './mutex';

// The email-security rules — sender spoofing, origin IP, the spam scorer and
// its verdict codec — were extracted to
// `@sarv-in/mailguard` so they could be maintained (and contributed to)
// as an open-source library. Re-exported here, under the names they always
// had, because every caller in this repo imports them from `@sarvinbox/core`
// and the move changed nothing about what they do.
export {
  assessSender,
  assessSpamSignals,
  domainOfAddress,
  domainsInText,
  extractAuthHeaderBlock,
  extractOriginIp,
  isFreemailAddress,
  isPublicIp,
  isSpamScore,
  linkDomains,
  normalizeIp,
  originIpFromAuthHeaders,
  originIpFromReceived,
  parseSpamReasons,
  registrableDomain,
  spamVerdict,
  stageOfReason,
  DATE_SKEW_SECONDS,
  LINK_DOMAINS_MAX,
  SPAM_HEADER_NAMES,
  SPAM_THRESHOLD,
  SUSPICIOUS_THRESHOLD,
  type LinkDomainsOptions,
  type OriginIpSources,
  type PhishingReason,
  type SpamAssessment,
  type SpamReason,
  type SpamReasonId,
  type SpamSignalInput,
  type SpamVerdict,
} from '@sarv-in/mailguard';

// The reputation, BIMI and favicon seams post-date the extraction above and
// keep a module of their own: each is the Inbox side of a library entry —
// the DNSBL operator names the shield shows, the cached brand-logo contract,
// the avatar fetch policy — not a bare re-export.
export * from './spam-reputation';
export * from './bimi';
export * from './favicon';
