import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newMigratedDb } from '../../../src/test-support/test-db';
import { PromptRepository } from '../../../src/repositories/prompt-repository';

// These rows ARE the AI agent's system prompts, and seedDefault runs on EVERY
// app start. If the upsert ever overwrote `content`, every startup would silently
// throw away the user's hand-tuned categorisation prompt — unrecoverable, since
// the app keeps no other copy. The mirror risk is `default_content` going stale,
// which would make the Reset button restore an old prompt. Both are pinned here.

const CATEGORIZATION = {
  id: 'categorization_system',
  label: 'Categorization',
  description: 'Classifies incoming mail',
  content: 'You are a mail classifier. v1',
};

describe('PromptRepository', () => {
  let db: Database.Database;
  let repo: PromptRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new PromptRepository(() => db);
  });

  afterEach(() => {
    db.close();
  });

  describe('seedDefault', () => {
    it('inserts a new prompt with content mirrored into default_content', () => {
      repo.seedDefault(CATEGORIZATION);

      const row = repo.get('categorization_system');
      expect(row).toMatchObject({
        id: 'categorization_system',
        label: 'Categorization',
        description: 'Classifies incoming mail',
        content: CATEGORIZATION.content,
        defaultContent: CATEGORIZATION.content,
      });
      expect(typeof row?.createdAt).toBe('number');
      expect(typeof row?.updatedAt).toBe('number');
    });

    it('stores null when no description is supplied', () => {
      repo.seedDefault({ id: 'agent_plan', label: 'Plan', content: 'plan prompt' });
      expect(repo.get('agent_plan')?.description).toBeNull();
      // An explicit null behaves the same as omitting it.
      repo.seedDefault({ id: 'agent_draft', label: 'Draft', description: null, content: 'draft prompt' });
      expect(repo.get('agent_draft')?.description).toBeNull();
    });

    it('is idempotent — re-seeding the identical row changes nothing and adds no duplicate', () => {
      repo.seedDefault(CATEGORIZATION);
      repo.seedDefault(CATEGORIZATION);
      repo.seedDefault(CATEGORIZATION);

      expect(repo.list()).toHaveLength(1);
      expect(repo.getContent('categorization_system')).toBe(CATEGORIZATION.content);
    });

    it('PRESERVES user-edited content while refreshing label/description/default_content', () => {
      repo.seedDefault(CATEGORIZATION);
      repo.update('categorization_system', 'MY hand-tuned prompt');

      // Next app release ships a new default prompt + renamed label.
      repo.seedDefault({
        id: 'categorization_system',
        label: 'Categorization (v2)',
        description: 'Now also sets needs_response',
        content: 'You are a mail classifier. v2',
      });

      const row = repo.get('categorization_system')!;
      expect(row.content).toBe('MY hand-tuned prompt');            // the user's edit survives
      expect(row.label).toBe('Categorization (v2)');               // metadata refreshed
      expect(row.description).toBe('Now also sets needs_response');
      expect(row.defaultContent).toBe('You are a mail classifier. v2');
    });

    it('makes Reset restore the NEWEST shipped default, not the one seeded first', () => {
      repo.seedDefault(CATEGORIZATION);
      repo.update('categorization_system', 'my edit');
      repo.seedDefault({ ...CATEGORIZATION, content: 'shipped v2' });

      expect(repo.reset('categorization_system')).toBe(true);
      expect(repo.getContent('categorization_system')).toBe('shipped v2');
    });
  });

  describe('get / getContent / list', () => {
    it('returns null for an unknown id on both getters (never undefined)', () => {
      expect(repo.get('nope')).toBeNull();
      expect(repo.getContent('nope')).toBeNull();
    });

    it('getContent returns just the live user content, including an empty string', () => {
      repo.seedDefault(CATEGORIZATION);
      expect(repo.getContent('categorization_system')).toBe(CATEGORIZATION.content);
      // A user who clears the textarea gets '' back — NOT the default, so the
      // caller can decide how to handle an intentionally blank prompt.
      repo.update('categorization_system', '');
      expect(repo.getContent('categorization_system')).toBe('');
    });

    it('lists every prompt oldest-first (the Settings tab order)', () => {
      repo.seedDefault({ id: 'agent_draft', label: 'Draft', content: 'd' });
      repo.seedDefault({ id: 'categorization_system', label: 'Categorization', content: 'c' });
      repo.seedDefault({ id: 'agent_plan', label: 'Plan', content: 'p' });
      // unixepoch() has 1-second resolution, so stamp distinct created_at values
      // instead of relying on how fast the test machine seeds three rows.
      const stamp = db.prepare('UPDATE agent_prompt_templates SET created_at = ? WHERE id = ?');
      stamp.run(1000, 'categorization_system');
      stamp.run(2000, 'agent_plan');
      stamp.run(3000, 'agent_draft');

      expect(repo.list().map((p) => p.id)).toEqual(['categorization_system', 'agent_plan', 'agent_draft']);
    });

    it('returns an empty list before anything is seeded', () => {
      expect(repo.list()).toEqual([]);
    });
  });

  describe('update / reset', () => {
    it('update saves the edit, leaves default_content alone, and reports true', () => {
      repo.seedDefault(CATEGORIZATION);
      expect(repo.update('categorization_system', 'edited prompt')).toBe(true);

      const row = repo.get('categorization_system')!;
      expect(row.content).toBe('edited prompt');
      expect(row.defaultContent).toBe(CATEGORIZATION.content);
    });

    it('update touches ONLY the addressed prompt', () => {
      repo.seedDefault(CATEGORIZATION);
      repo.seedDefault({ id: 'agent_plan', label: 'Plan', content: 'plan prompt' });

      repo.update('agent_plan', 'edited plan');
      expect(repo.getContent('agent_plan')).toBe('edited plan');
      expect(repo.getContent('categorization_system')).toBe(CATEGORIZATION.content);
    });

    it('reset copies default_content back over content and reports true', () => {
      repo.seedDefault(CATEGORIZATION);
      repo.update('categorization_system', 'broken prompt the model hates');

      expect(repo.reset('categorization_system')).toBe(true);
      expect(repo.getContent('categorization_system')).toBe(CATEGORIZATION.content);
      // Reset is idempotent — pressing it twice is harmless.
      expect(repo.reset('categorization_system')).toBe(true);
      expect(repo.getContent('categorization_system')).toBe(CATEGORIZATION.content);
    });

    it('update/reset on an unknown id report false and create nothing', () => {
      expect(repo.update('ghost', 'x')).toBe(false);
      expect(repo.reset('ghost')).toBe(false);
      expect(repo.list()).toEqual([]);
    });
  });

  it('throws Storage not initialized when the DB is not ready yet', () => {
    const detached = new PromptRepository(() => undefined as unknown as Database.Database);
    expect(() => detached.list()).toThrow('Storage not initialized');
  });
});
