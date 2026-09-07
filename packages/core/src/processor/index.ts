// Email Processor Module
export {
  parseAuthenticationHeaders,
  hasBulkHeaders,
  isReplyToMyEmail,
  hasUrgencyKeywords,
  calculateImportanceScore,
  getImportanceLevel,
  IMPORTANCE_WEIGHTS,
  IMPORTANCE_THRESHOLDS,
  type AuthStatus,
  type SenderContext,
  type ImportanceResult,
  type ImportanceFactor,
} from './email-processor';
