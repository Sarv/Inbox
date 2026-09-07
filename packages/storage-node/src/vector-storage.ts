// Vector storage implementation using sqlite-vss

import type {
  IVectorStorage,
  SimilarityResult,
  EmbeddingMetadata,
} from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';
import Database from 'better-sqlite3';
const logger = createLogger('vector-storage');

/**
 * SQLite Vector Storage implementation using sqlite-vss
 */
export class SQLiteVectorStorage implements IVectorStorage {
  private db: Database.Database | null = null;
  private initialized = false;
  private dimensions: number = 1536; // Default: OpenAI ada-002

  constructor(
    private dbPath: string,
    dimensions?: number
  ) {
    if (dimensions) {
      this.dimensions = dimensions;
    }
  }

  // ========== Connection & Lifecycle ==========

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Open database (same as email storage)
    this.db = new Database(this.dbPath);

    // Load sqlite-vss extension
    try {
      // Try to load vss extension (platform-specific)
      // On macOS: vss0.dylib, on Linux: vss0.so, on Windows: vss0.dll
      const extensions = ['vss0', 'vss0.dylib', 'vss0.so', 'vss0.dll'];

      for (const ext of extensions) {
        try {
          this.db.loadExtension(ext);
          break;
        } catch {
          // Try next
        }
      }
    } catch (error) {
      logger.warn('Failed to load sqlite-vss extension:', error);
      logger.warn('Vector search will not be available');
      // Continue without vss - will throw error if vector methods are called
    }

    // Create virtual table for vectors
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vss0(
          embedding(${this.dimensions})
        );
      `);
    } catch (error) {
      logger.error('Failed to create embeddings table:', error);
      // Table might already exist or vss not loaded
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('Vector storage not initialized');
    }
  }

  // ========== Embedding Operations ==========

  async insertEmbedding(
    emailId: string,
    embedding: number[],
    metadata: EmbeddingMetadata
  ): Promise<void> {
    this.ensureInitialized();

    // Validate dimensions
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }

    // Convert embedding to blob
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);

    // One transaction: if the vector write fails, the metadata row must
    // not persist — otherwise hasEmbedding() reports true forever and
    // the email is never re-attempted.
    this.db!.transaction(() => {
      // Insert metadata
      this.db!.prepare(`
        INSERT INTO embedding_metadata (email_id, content_hash, model_name, dimensions, provider)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          model_name = excluded.model_name,
          dimensions = excluded.dimensions,
          provider = excluded.provider
      `).run(
        emailId,
        metadata.contentHash,
        metadata.modelName,
        metadata.dimensions,
        metadata.provider
      );

      // Insert vector — vss0 virtual tables don't support UPSERT, so
      // delete any existing row first.
      this.db!.prepare(`
        DELETE FROM embeddings
        WHERE rowid = (SELECT rowid FROM emails WHERE id = ?)
      `).run(emailId);

      this.db!.prepare(`
        INSERT INTO embeddings (rowid, embedding)
        VALUES (
          (SELECT rowid FROM emails WHERE id = ?),
          ?
        )
      `).run(emailId, embeddingBlob);

      // Update email record
      this.db!.prepare(`
        UPDATE emails
        SET has_embedding = 1, embedding_last_generated = ?
        WHERE id = ?
      `).run(Math.floor(Date.now() / 1000), emailId);
    })();
  }

  async insertEmbeddingBatch(
    embeddings: Array<{
      emailId: string;
      embedding: number[];
      metadata: EmbeddingMetadata;
    }>
  ): Promise<void> {
    this.ensureInitialized();

    const insert = this.db!.transaction((embeddings: any[]) => {
      for (const item of embeddings) {
        this.insertEmbedding(item.emailId, item.embedding, item.metadata);
      }
    });

    insert(embeddings);
  }

  async hasEmbedding(emailId: string, contentHash: string): Promise<boolean> {
    this.ensureInitialized();

    const result = this.db!.prepare(`
      SELECT 1 FROM embedding_metadata
      WHERE email_id = ? AND content_hash = ?
    `).get(emailId, contentHash);

    return result !== undefined;
  }

  async getEmbeddingMetadata(emailId: string): Promise<EmbeddingMetadata | null> {
    this.ensureInitialized();

    const row = this.db!.prepare(`
      SELECT * FROM embedding_metadata WHERE email_id = ?
    `).get(emailId) as any;

    if (!row) {
      return null;
    }

    return {
      emailId: row.email_id,
      contentHash: row.content_hash,
      modelName: row.model_name,
      dimensions: row.dimensions,
      provider: row.provider,
      createdAt: row.created_at,
    };
  }

  async deleteEmbedding(emailId: string): Promise<void> {
    this.ensureInitialized();

    // Delete from embeddings virtual table
    this.db!.prepare(`
      DELETE FROM embeddings
      WHERE rowid = (SELECT rowid FROM emails WHERE id = ?)
    `).run(emailId);

    // Delete metadata
    this.db!.prepare('DELETE FROM embedding_metadata WHERE email_id = ?').run(emailId);

    // Update email record
    this.db!.prepare(`
      UPDATE emails
      SET has_embedding = 0, embedding_last_generated = NULL
      WHERE id = ?
    `).run(emailId);
  }

  async deleteEmbeddings(emailIds: string[]): Promise<void> {
    this.ensureInitialized();

    const deleteStmt = this.db!.transaction((emailIds: string[]) => {
      for (const emailId of emailIds) {
        this.deleteEmbedding(emailId);
      }
    });

    deleteStmt(emailIds);
  }

  // ========== Vector Search ==========

  async searchSimilar(
    queryEmbedding: number[],
    limit: number,
    threshold?: number
  ): Promise<SimilarityResult[]> {
    this.ensureInitialized();

    // Validate dimensions
    if (queryEmbedding.length !== this.dimensions) {
      throw new Error(
        `Query embedding dimensions mismatch: expected ${this.dimensions}, got ${queryEmbedding.length}`
      );
    }

    // Convert query embedding to blob
    const queryBlob = Buffer.from(new Float32Array(queryEmbedding).buffer);

    // Search using vss
    // vss_search returns distance (0 = identical, higher = more different)
    const sql = `
      SELECT
        emails.id as email_id,
        vss_search.distance
      FROM embeddings
      INNER JOIN emails ON embeddings.rowid = emails.rowid
      WHERE vss_search(
        embeddings.embedding,
        ?
      )
      LIMIT ?
    `;

    const rows = this.db!.prepare(sql).all(queryBlob, limit) as any[];

    // Convert distance to similarity score
    // Cosine distance: 0 = identical, 2 = opposite
    // Similarity: 1 = identical, 0 = opposite
    const results: SimilarityResult[] = rows.map(row => ({
      emailId: row.email_id,
      distance: row.distance,
      similarity: 1 - row.distance / 2,
    }));

    // Filter by threshold if provided
    if (threshold !== undefined) {
      return results.filter(r => r.similarity >= threshold);
    }

    return results;
  }

  async getEmbeddingCount(): Promise<number> {
    this.ensureInitialized();

    const result = this.db!.prepare(
      'SELECT COUNT(*) as count FROM embedding_metadata'
    ).get() as any;

    return result.count;
  }
}
