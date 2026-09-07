// Sarv Inbox Core - Platform-agnostic business logic

// ========== Types ==========
export * from './types/models';
export * from './types/storage';
export * from './types/filters';
export * from './types/labels';
export * from './types/imap';
export * from './types/smtp';
export * from './types/embeddings';
export * from './types/llm';
export * from './types/agent';

// ========== Modules ==========

// IMAP
export * from './imap';

// SMTP
export * from './smtp';

// OAuth
export * from './oauth';

// Parser
export * from './parser';

// Pipeline System
export * from './pipeline';

// Extensions
export * from './extensions';

// Background Tasks
export * from './background';

// Threading
// export * from './threading/thread-builder';

// Embeddings
// export * from './embeddings/embedding-queue';
// export * from './embeddings/providers/openai';

// Search
// export * from './search/hybrid-search';
// export * from './search/rag-builder';

// Automation
// export * from './automation/auto-labeler';
// export * from './automation/reply-suggester';

// Utils
export * from './utils';

// Email Processor
export * from './processor';

// Email Agent
export * from './agent';

// Config
export * from './config';

// Contact Enrichment (v39) — NOT exported from the barrel because the
// renderer (which uses Vite) can't import from `@sarvinbox/core` at
// runtime (the barrel drags imapflow/nodemailer in). A duplicate
// lives at apps/desktop/src/services/contact-enrichment/ for renderer
// use. The core copy stays available to node-side code via deep
// import (`@sarvinbox/core/dist/.../contact-enrichment`) if ever
// needed — today nothing node-side uses it.
//
// EXCEPTION: the deterministic phone classifier is pure (no imapflow/nodemailer)
// and is used node-side by the contact scan, so it IS re-exported here.
export {
  minePhones,
  mineAttributedPhones,
  mineLinkedIn,
  mineContactSignals,
  classifyDomainPhones,
  classifyDomainUrls,
  domainOf as phoneDomainOf,
  PUBLIC_DOMAINS,
  type SenderPhones,
  type ClassifiedPhones,
  type MinedLinkedIn,
  type MinedContactSignals,
  type SenderUrls,
  type ClassifiedUrls,
  type DomainOrgUrls,
} from './contact-enrichment/phone-classifier';

// Weighted phone scoring. Pure (no imapflow/nodemailer), so it is safe in the
// root barrel alongside the classifier and reachable from the node-side scan.
export {
  scoreCandidate,
  applyDomainSignals,
  classifyScore,
  classifyPhone,
  nameTokensFor,
  looksLikeDisclaimer,
  PHONE_SCORE,
  DIRECT_THRESHOLD,
  COMPANY_THRESHOLD,
  type PhoneZone,
  type PhoneCandidate,
  type ScoredPhone,
  type DomainPhoneStats,
  type PhoneClass,
} from './contact-enrichment/phone-scoring';

export { segmentZones, setSignatureSplitter, type Zone, type SignatureSplitter } from './contact-enrichment/zones';

// NODE-ONLY. email-reply-parser's regex.js does a bare `require("re2")` to pick
// up an optional native regex engine; the call is inside a try/catch, but a
// bundled renderer has no `require` at all, so esbuild's shim throws "Dynamic
// require of module is not supported" before the catch can swallow it — a blank
// window. Exposed on the root barrel, which only the main process imports; the
// renderer uses the '@sarvinbox/core/contact-enrichment' subpath and never
// reaches this.
export {
  installNodeSignatureSplitter,
  splitSignaturesWithParser,
  visibleTextWithParser,
} from './contact-enrichment/signature-splitter-node';

export const version = '0.1.2';
