// Email Agent Module

export { EmailAgent, type EmailAgentDeps } from './email-agent';
export { BehaviorAnalyzer, type BehaviorAnalyzerConfig } from './behavior-analyzer';
export { BehaviorIntelligence, type BehaviorIntelligenceDeps } from './behavior-intelligence';
export { UnifiedPipeline, type UnifiedPipelineDeps, type UnifiedPipelineConfig, type PipelineResult } from './unified-pipeline';
export { ReplyStyleAnalyzer, type ReplyStyleProfile } from './reply-style-analyzer';
export {
  AgentReplyDrafter,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_DRAFT_TEMPLATE,
  type ReplyDrafterDeps,
  type DraftResult,
} from './reply-drafter';
export * from './signals';
export {
  stripThinkingTags,
  stripMarkdownFences,
  cleanLLMJsonResponse,
  escapeUnescapedControlCharsInJsonStrings,
  tryParseLLMJson,
  salvageJsonArray,
  salvageJsonArrayWithDiagnostics,
  extractBalancedJsonArray,
} from './llm-response-utils';
export type { SalvageDiagnostics } from './llm-response-utils';
export {
  applySecurityGate,
  buildCategorizationPrompt,
  buildEmailText,
  buildSecurityContext,
  formatSecurityLines,
  validateCategorizationResponse,
  callAIProvider,
  callAIWithRetry,
  SarvApiError,
  DECEPTION_REASON_IDS,
  JUDGEMENT_CATEGORIES,
  MAX_API_RETRIES,
  DEFAULT_CATEGORIZATION_TEMPLATE,
  PHISHING_PROMPT,
  SPAM_PROMPT,
  type AIProviderConfig,
  type SarvErrorCode,
  type EmailSecurityContext,
  type EnrichedEmail,
  type GateableResult,
  type SecuritySourceRow,
  type SenderSignals,
  type CategoryDef,
  type CategorizationResult,
} from './categorization-utils';
export {
  MAX_AGENT_FAILURES,
  classifyCategorizationPass,
  decideCategorizationAction,
  strikeLimitFor,
  type CategorizationPass,
  type CategorizationOutcome,
  type CategorizationAction,
} from './categorization-outcome';
