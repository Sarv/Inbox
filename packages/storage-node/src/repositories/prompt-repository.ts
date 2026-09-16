// Prompt Repository — user-editable AI agent prompt templates.
//
// Three well-known keys drive the agent pipeline:
//   - categorization_system : full system prompt for Pipeline 2 (classifies
//                             emails, sets needs_response + should_auto_draft)
//   - agent_plan            : reply drafter's "do I need to search first?" step
//   - agent_draft           : reply drafter's "now write the reply" step
//
// Each record stores the user-editable `content` and an immutable
// `default_content` so the UI can offer a Reset action.
//
// Placeholders like {{userName}} / {{userEmail}} / {{aliases}} etc. are
// substituted at call time by the prompt-loader (see @sarvinbox/core).

import { BaseRepository, type DatabaseAccessor } from './base-repository';

export interface AgentPromptTemplate {
  id: string;
  label: string;
  description: string | null;
  content: string;
  defaultContent: string;
  updatedAt: number;
  createdAt: number;
}

export class PromptRepository extends BaseRepository {
  constructor(getDb: DatabaseAccessor) {
    super(getDb);
  }

  /**
   * Insert a default prompt if it doesn't already exist. Idempotent —
   * safe to call on every startup. Does NOT overwrite user edits.
   */
  seedDefault(row: {
    id: string;
    label: string;
    description?: string | null;
    content: string;
  }): void {
    // On conflict, a user's EDITED content is preserved — but an UNEDITED one
    // adopts the new default.
    //
    // Only `default_content` used to be refreshed, which meant an upstream
    // prompt fix reached nobody: every install already has the row, so the live
    // `content` kept whatever shipped on first run and the improvement sat in a
    // column only the Reset button reads. A user would have had to guess that a
    // prompt they never touched needed resetting.
    //
    // "Unedited" is `content = default_content` — exactly how seeding left it.
    // The moment the user edits, the two diverge and their text is never
    // overwritten. SQLite evaluates every SET expression against the ORIGINAL
    // row, so the comparison sees the OLD default even though this same
    // statement replaces it.
    this.db
      .prepare(
        `INSERT INTO agent_prompt_templates (id, label, description, content, default_content)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           description = excluded.description,
           content = CASE
             WHEN agent_prompt_templates.content IS agent_prompt_templates.default_content
               THEN excluded.content
             ELSE agent_prompt_templates.content
           END,
           default_content = excluded.default_content`,
      )
      .run(
        row.id,
        row.label,
        row.description ?? null,
        row.content,
        row.content,
      );
  }

  /**
   * Fetch a single prompt by id. Returns null if the id is unknown.
   */
  get(id: string): AgentPromptTemplate | null {
    const row = this.db
      .prepare(
        `SELECT id, label, description, content, default_content as defaultContent,
                updated_at as updatedAt, created_at as createdAt
           FROM agent_prompt_templates WHERE id = ?`,
      )
      .get(id) as any;
    return row || null;
  }

  /**
   * Fetch just the `content` for a prompt. Hot path used by prompt builders
   * on every LLM call — stays a single indexed lookup.
   */
  getContent(id: string): string | null {
    const row = this.db
      .prepare(`SELECT content FROM agent_prompt_templates WHERE id = ?`)
      .get(id) as any;
    return row?.content ?? null;
  }

  /** List every prompt, oldest-first — drives the Settings UI. */
  list(): AgentPromptTemplate[] {
    return this.db
      .prepare(
        `SELECT id, label, description, content, default_content as defaultContent,
                updated_at as updatedAt, created_at as createdAt
           FROM agent_prompt_templates ORDER BY created_at ASC`,
      )
      .all() as any[];
  }

  /** Save user-edited content for a prompt. */
  update(id: string, content: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_prompt_templates SET content = ?, updated_at = unixepoch() WHERE id = ?`,
      )
      .run(content, id);
    return result.changes > 0;
  }

  /** Revert a prompt back to the seeded default. */
  reset(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_prompt_templates
            SET content = default_content, updated_at = unixepoch()
          WHERE id = ?`,
      )
      .run(id);
    return result.changes > 0;
  }
}
