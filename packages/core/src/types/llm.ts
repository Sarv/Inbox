// LLM provider interface for Sarv Inbox

/**
 * LLM provider interface (OpenAI-compatible)
 */
export interface ILLMProvider {
  /**
   * Generate completion
   */
  generateCompletion(
    prompt: string,
    options?: CompletionOptions
  ): Promise<string>;

  /**
   * Generate chat completion
   */
  generateChatCompletion(
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<string>;

  /**
   * Stream completion
   */
  streamCompletion(
    prompt: string,
    options?: CompletionOptions
  ): AsyncIterableIterator<string>;

  /**
   * Stream chat completion
   */
  streamChatCompletion(
    messages: ChatMessage[],
    options?: CompletionOptions
  ): AsyncIterableIterator<string>;

  /**
   * Get model name
   */
  getModelName(): string;

  /**
   * Get provider name
   */
  getProviderName(): string;

  /**
   * Test connection
   */
  testConnection(): Promise<boolean>;
}

/**
 * LLM provider configuration
 */
export interface LLMProviderConfig {
  provider: 'openai' | 'anthropic' | 'local' | 'custom';
  apiBaseUrl: string; // e.g., "https://api.openai.com/v1"
  apiKey: string;
  modelName: string; // e.g., "gpt-4", "gpt-3.5-turbo", "claude-3-opus"
  timeout?: number; // Request timeout in milliseconds
  maxRetries?: number;
}

/**
 * Chat message
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string; // Optional message author name
}

/**
 * Completion options
 */
export interface CompletionOptions {
  temperature?: number; // 0-2, default 0.7
  maxTokens?: number;
  topP?: number; // 0-1, nucleus sampling
  frequencyPenalty?: number; // -2 to 2
  presencePenalty?: number; // -2 to 2
  stop?: string[]; // Stop sequences
  stream?: boolean; // Enable streaming
}

/**
 * RAG (Retrieval-Augmented Generation) interface
 */
export interface IRAGService {
  /**
   * Initialize RAG service
   */
  initialize(llmConfig: LLMProviderConfig): Promise<void>;

  /**
   * Ask a question about the inbox
   */
  askQuestion(
    question: string,
    options?: RAGOptions
  ): Promise<RAGResponse>;

  /**
   * Stream answer to question
   */
  askQuestionStream(
    question: string,
    options?: RAGOptions
  ): AsyncIterableIterator<RAGStreamChunk>;

  /**
   * Generate email reply suggestion
   */
  suggestReply(
    emailContent: string,
    threadHistory?: string[]
  ): Promise<string[]>; // Returns multiple suggestions

  /**
   * Generate email summary
   */
  summarizeEmail(emailContent: string): Promise<string>;

  /**
   * Generate thread summary
   */
  summarizeThread(emails: string[]): Promise<string>;

  /**
   * Classify email (category, priority, etc.)
   */
  classifyEmail(emailContent: string): Promise<EmailClassification>;
}

/**
 * RAG options
 */
export interface RAGOptions {
  maxContext: number; // Maximum emails to include in context
  includeThreads?: boolean; // Include full thread context
  filterFolders?: string[]; // Limit search to specific folders
  dateRange?: {
    from?: number; // Unix timestamp
    to?: number;
  };
  temperature?: number;
  stream?: boolean;
}

/**
 * RAG response
 */
export interface RAGResponse {
  answer: string;
  sources: RAGSource[]; // Source emails used
  confidence: number; // 0-1
  tokensUsed: number;
}

/**
 * RAG stream chunk
 */
export interface RAGStreamChunk {
  type: 'token' | 'sources' | 'done';
  content?: string; // For 'token' type
  sources?: RAGSource[]; // For 'sources' type
}

/**
 * RAG source email
 */
export interface RAGSource {
  emailId: string;
  subject: string;
  from: string;
  date: number;
  snippet: string; // Relevant excerpt
  relevance: number; // 0-1
}

/**
 * Email classification
 */
export interface EmailClassification {
  category: string; // e.g., "work", "personal", "newsletter", "spam"
  priority: 'low' | 'normal' | 'high';
  sentiment: 'negative' | 'neutral' | 'positive';
  actionRequired: boolean;
  suggestedLabels: string[];
  confidence: number; // 0-1
}

/**
 * Auto-labeling service
 */
export interface IAutoLabelService {
  /**
   * Suggest labels for an email
   */
  suggestLabels(emailId: string): Promise<LabelSuggestion[]>;

  /**
   * Learn from user label actions (improve suggestions)
   */
  learnFromAction(
    emailId: string,
    appliedLabels: string[],
    rejectedLabels: string[]
  ): Promise<void>;

  /**
   * Get label suggestions for multiple emails
   */
  suggestLabelsBatch(emailIds: string[]): Promise<Map<string, LabelSuggestion[]>>;
}

/**
 * Label suggestion
 */
export interface LabelSuggestion {
  label: string;
  confidence: number; // 0-1
  reason: string; // Why this label was suggested
}

/**
 * LLM error
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public code: LLMErrorCode,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * LLM error codes
 */
export enum LLMErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  INVALID_API_KEY = 'INVALID_API_KEY',
  INVALID_MODEL = 'INVALID_MODEL',
  CONTEXT_TOO_LONG = 'CONTEXT_TOO_LONG',
  CONTENT_FILTER = 'CONTENT_FILTER',
  UNKNOWN = 'UNKNOWN',
}
