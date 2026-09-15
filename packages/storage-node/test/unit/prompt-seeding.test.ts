import { describe, it, expect } from 'vitest';

import { PromptRepository } from '../../src/repositories/prompt-repository';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Seeding the user-editable agent prompts.
 *
 * THE bug: `seedDefault` refreshed only `default_content` on conflict, so an
 * upstream prompt fix reached NOBODY. Every install already has the row from
 * first run, so the live `content` kept the original text and the improvement
 * sat in a column only the Reset button reads — a user would have had to guess
 * that a prompt they had never touched needed resetting.
 *
 * Found while fixing a categorization prompt that was returning no category for
 * 73% of mail: all three of the reporting user's prompts were byte-identical to
 * their defaults, and the fix would still not have reached them.
 */
const repo = () => {
  const db = newMigratedDb();
  return { db, prompts: new PromptRepository(() => db) };
};

const seed = (prompts: PromptRepository, content: string) =>
  prompts.seedDefault({ id: 'categorization_system', label: 'Categorization', content });

const row = (db: ReturnType<typeof newMigratedDb>) =>
  db.prepare(`SELECT content, default_content, label FROM agent_prompt_templates WHERE id = 'categorization_system'`)
    .get() as { content: string; default_content: string; label: string };

describe('seedDefault', () => {
  it('creates the row on a fresh install with content and default in step', () => {
    const { db, prompts } = repo();
    seed(prompts, 'v1 prompt');

    expect(row(db)).toMatchObject({ content: 'v1 prompt', default_content: 'v1 prompt' });
  });

  // THE regression. An unedited prompt must pick up the upstream fix, or
  // shipping a prompt improvement is a no-op for every existing install.
  it('upgrades an UNEDITED prompt to the new default', () => {
    const { db, prompts } = repo();
    seed(prompts, 'v1 prompt');

    seed(prompts, 'v2 prompt — assigns categories properly');

    expect(row(db).content).toBe('v2 prompt — assigns categories properly');
    expect(row(db).default_content).toBe('v2 prompt — assigns categories properly');
  });

  // The other half of the contract, and the reason the old code was cautious:
  // a user who tuned their prompt must never have it silently replaced.
  it('never overwrites a prompt the user has edited', () => {
    const { db, prompts } = repo();
    seed(prompts, 'v1 prompt');
    db.prepare(`UPDATE agent_prompt_templates SET content = 'my own careful prompt' WHERE id = 'categorization_system'`).run();

    seed(prompts, 'v2 prompt');

    expect(row(db).content).toBe('my own careful prompt');
    // …but Reset still offers them the new one.
    expect(row(db).default_content).toBe('v2 prompt');
  });

  // Editing and then reverting by hand leaves content == default again. That is
  // indistinguishable from never having edited, and treating it as unedited is
  // the right call: the user's current text IS the default.
  it('treats a hand-reverted prompt as unedited', () => {
    const { db, prompts } = repo();
    seed(prompts, 'v1 prompt');
    db.prepare(`UPDATE agent_prompt_templates SET content = 'scratch' WHERE id = 'categorization_system'`).run();
    db.prepare(`UPDATE agent_prompt_templates SET content = 'v1 prompt' WHERE id = 'categorization_system'`).run();

    seed(prompts, 'v2 prompt');

    expect(row(db).content).toBe('v2 prompt');
  });

  it('refreshes the label and description whichever branch is taken', () => {
    const { db, prompts } = repo();
    seed(prompts, 'v1 prompt');
    db.prepare(`UPDATE agent_prompt_templates SET content = 'edited' WHERE id = 'categorization_system'`).run();

    prompts.seedDefault({ id: 'categorization_system', label: 'New label', content: 'v2' });

    expect(row(db).label).toBe('New label');
  });

  // Re-seeding runs on EVERY app start. It must be a no-op, not a write that
  // churns the row or flips content back and forth.
  it('is idempotent across repeated startups', () => {
    const { db, prompts } = repo();
    seed(prompts, 'v1 prompt');
    seed(prompts, 'v1 prompt');
    seed(prompts, 'v1 prompt');

    expect(row(db)).toMatchObject({ content: 'v1 prompt', default_content: 'v1 prompt' });
  });
});
