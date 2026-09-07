export {
  extractSignals,
  mergeSignals,
  extractSignatureBlock,
  stripQuotedTail,
  setExtractorSignatureSplitter,
  SIGNATURE_DELIMITERS,
  type ExtractedSignals,
} from './signal-extractor';

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
} from './phone-scoring';

export { segmentZones, setSignatureSplitter, type Zone, type SignatureSplitter } from './zones';

export {
  extractDeterministicProfile,
  type DeterministicProfile,
} from './deterministic-profile';

export {
  normalizePhoneToE164,
  normalizePhones,
} from './phone-normalizer';

export {
  minePhones,
  mineAttributedPhones,
  mineLinkedIn,
  mineContactSignals,
  classifyDomainPhones,
  domainOf,
  PUBLIC_DOMAINS,
  type SenderPhones,
  type ClassifiedPhones,
  type MinedLinkedIn,
  type MinedContactSignals,
} from './phone-classifier';

export {
  buildEnrichmentUserMessage,
  ENRICHMENT_SYSTEM_PROMPT,
  type EnrichmentPromptInput,
} from './prompt-builder';

export {
  parseEnrichmentResponse,
  EnrichmentParseError,
} from './response-parser';

// The enrichment blob shape. Re-exported here so consumers (including the
// renderer) get it from this module rather than re-declaring it — an inlined
// duplicate is exactly how the two copies drifted apart before.
export type { ContactEnrichment } from '../types/models';
