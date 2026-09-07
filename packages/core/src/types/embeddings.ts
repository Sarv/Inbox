// Embedding provider interface for Sarv Inbox

/**
 * Embedding provider interface (OpenAI-compatible)
 */
export interface IEmbeddingProvider {
  /**
   * Generate embedding for text
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts (batch)
   */
  generateEmbeddingBatch(texts: string[]): Promise<number[][]>;

  /**
   * Get embedding dimensions
   */
  getDimensions(): number;

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
 * Embedding provider configuration
 */
export interface EmbeddingProviderConfig {
  provider: 'openai' | 'local' | 'custom';
  apiBaseUrl: string; // e.g., "https://api.openai.com/v1"
  apiKey: string;
  modelName: string; // e.g., "text-embedding-ada-002" or "text-embedding-3-small"
  dimensions?: number; // Auto-detected if not provided
  maxBatchSize?: number; // Maximum texts per batch request
  timeout?: number; // Request timeout in milliseconds
}

/**
 * Embedding queue item
 */
export interface EmbeddingQueueItem {
  emailId: string;
  text: string; // Clean content to embed
  contentHash: string;
  priority: 'high' | 'normal' | 'low';
  retryCount: number;
  createdAt: number;
}

/**
 * Embedding queue status
 */
export interface EmbeddingQueueStatus {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  estimatedTimeRemaining: number | null; // Seconds
}

/**
 * Embedding result
 */
export interface EmbeddingResult {
  emailId: string;
  embedding: number[];
  contentHash: string;
  modelName: string;
  dimensions: number;
  success: boolean;
  error?: string;
}

/**
 * Embedding service interface
 */
export interface IEmbeddingService {
  /**
   * Initialize service
   */
  initialize(config: EmbeddingProviderConfig): Promise<void>;

  /**
   * Add email to embedding queue
   */
  enqueueEmail(emailId: string, text: string, contentHash: string): Promise<void>;

  /**
   * Add multiple emails to queue
   */
  enqueueEmailBatch(
    items: Array<{ emailId: string; text: string; contentHash: string }>
  ): Promise<void>;

  /**
   * Process embedding queue
   */
  processQueue(): Promise<void>;

  /**
   * Get queue status
   */
  getQueueStatus(): Promise<EmbeddingQueueStatus>;

  /**
   * Clear queue
   */
  clearQueue(): Promise<void>;

  /**
   * Pause queue processing
   */
  pause(): void;

  /**
   * Resume queue processing
   */
  resume(): void;

  /**
   * Check if processing
   */
  isProcessing(): boolean;
}

/**
 * Embedding error
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public code: EmbeddingErrorCode,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * Embedding error codes
 */
export enum EmbeddingErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  INVALID_API_KEY = 'INVALID_API_KEY',
  INVALID_MODEL = 'INVALID_MODEL',
  TEXT_TOO_LONG = 'TEXT_TOO_LONG',
  UNKNOWN = 'UNKNOWN',
}
