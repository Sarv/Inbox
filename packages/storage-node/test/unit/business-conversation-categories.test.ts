import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  businessConversationCategories,
  initialTagsSchema,
  LEGACY_NEEDS_RESPONSE_PROMPT,
  LEGACY_PROMOTIONS_PROMPT,
  MigrationManager,
  NEEDS_RESPONSE_PROMPT,
  PROMOTIONS_PROMPT,
  promotionsCategory,
} from '../../src/migrations';
import { newMigratedDb, openTestDb } from '../../src/test-support/test-db';

interface CategoryRow {
  slug: string;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  color: string;
  sort_order: number;
  is_system: number;
  is_enabled: number;
  updated_at: number;
}

const legacyCategories = [
  { slug: 'needs_response', name: 'Needs Response', description: 'Emails that require your reply',
    prompt: LEGACY_NEEDS_RESPONSE_PROMPT, icon: 'MessageCircle', color: 'orange', sort_order: 2 },
  { slug: 'promotions', name: 'Promotions', description: 'Sales outreach, newsletters, product marketing',
    prompt: LEGACY_PROMOTIONS_PROMPT, icon: 'Megaphone', color: 'pink', sort_order: 8 },
] as const;

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function legacyDb(): Database.Database {
  const db = openTestDb();
  databases.push(db);
  db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version VALUES (103);
    CREATE TABLE ai_category_definitions (
      slug TEXT PRIMARY KEY, name TEXT, description TEXT, prompt TEXT, icon TEXT,
      color TEXT, sort_order INTEGER, is_system INTEGER, is_enabled INTEGER, updated_at INTEGER
    );
    CREATE TABLE emails (id TEXT PRIMARY KEY, tags TEXT, manual_categories TEXT,
      server_categories TEXT, ai_categories TEXT, agent_status TEXT);
    INSERT INTO emails VALUES ('chosen', '|INBOX|promotions|needs_response|',
      '["promotions","needs_response"]', '["promotions","needs_response"]',
      '|promotions|needs_response|', 'done');`);
  const insert = db.prepare(`INSERT INTO ai_category_definitions
    VALUES (@slug, @name, @description, @prompt, @icon, @color, @sort_order, 1, 0, 10)`);
  for (const category of legacyCategories) insert.run(category);
  return db;
}

function categories(db: Database.Database): CategoryRow[] {
  return db.prepare('SELECT * FROM ai_category_definitions ORDER BY slug').all() as CategoryRow[];
}

function manager(db: Database.Database): MigrationManager {
  const migrations = new MigrationManager(db);
  migrations.register(businessConversationCategories);
  return migrations;
}

describe('business conversation category defaults', () => {
  // Fresh SQL seeds and the completed production chain must classify business work using the same prompts.
  it('uses the refreshed defaults in fresh schema and the complete migration chain', () => {
    const schemaDb = openTestDb();
    databases.push(schemaDb);
    initialTagsSchema.up(schemaDb, {});
    const migratedDb = newMigratedDb();
    databases.push(migratedDb);
    for (const db of [schemaDb, migratedDb]) {
      const prompts = db.prepare("SELECT slug, prompt FROM ai_category_definitions WHERE slug IN ('needs_response', 'promotions') ORDER BY slug").all();
      expect(prompts).toEqual([
        { slug: 'needs_response', prompt: NEEDS_RESPONSE_PROMPT },
        { slug: 'promotions', prompt: PROMOTIONS_PROMPT },
      ]);
    }
  });

  // Exporting v36's defaults must not alter historical migration behavior or leave its reply prompt on fresh installs.
  it('keeps v36 behavior unchanged and upgrades its exact old reply default', () => {
    const db = openTestDb();
    databases.push(db);
    initialTagsSchema.up(db, {});
    promotionsCategory.up(db, {});
    expect(db.prepare("SELECT prompt FROM ai_category_definitions WHERE slug = 'needs_response'").get())
      .toEqual({ prompt: LEGACY_NEEDS_RESPONSE_PROMPT });
    expect(db.prepare("SELECT prompt FROM ai_category_definitions WHERE slug = 'promotions'").get())
      .toEqual({ prompt: PROMOTIONS_PROMPT });
    businessConversationCategories.up(db, {});
    expect(db.prepare("SELECT prompt FROM ai_category_definitions WHERE slug = 'needs_response'").get())
      .toEqual({ prompt: NEEDS_RESPONSE_PROMPT });
  });

  // Improving default interpretation must not retag old mail, remove explicit overlap, enable disabled categories, or queue paid AI calls.
  it('upgrades untouched defaults while preserving every message and category preference', () => {
    const db = legacyDb();
    const before = categories(db);
    const mail = db.prepare('SELECT * FROM emails').all();
    manager(db).migrate();
    const after = categories(db);
    expect(after.map((category) => category.prompt)).toEqual([NEEDS_RESPONSE_PROMPT, PROMOTIONS_PROMPT]);
    for (let index = 0; index < after.length; index++) {
      expect({ ...after[index], prompt: before[index].prompt, updated_at: before[index].updated_at }).toEqual(before[index]);
      expect(after[index].updated_at).toBeGreaterThan(10);
    }
    expect(db.prepare('SELECT * FROM emails').all()).toEqual(mail);
    expect(manager(db).getCurrentVersion()).toBe(104);
    const upgraded = categories(db);
    manager(db).migrate();
    businessConversationCategories.up(db, {});
    expect(categories(db)).toEqual(upgraded);
  });

  // A user's prompt, display name, appearance, order, or ownership edit must survive a default update.
  it.each([
    ['prompt', 'My custom business rule'], ['name', 'My Reply Queue'], ['description', 'Custom description'],
    ['icon', 'Mail'], ['color', 'purple'], ['sort_order', 99], ['is_system', 0],
  ] as const)('preserves a category customized through %s', (field, value) => {
    const db = legacyDb();
    db.prepare(`UPDATE ai_category_definitions SET ${field} = ? WHERE slug = 'needs_response'`).run(value);
    const customized = categories(db).find((category) => category.slug === 'needs_response');
    businessConversationCategories.up(db, {});
    expect(categories(db).find((category) => category.slug === 'needs_response')).toEqual(customized);
    expect(categories(db).find((category) => category.slug === 'promotions')?.prompt).toBe(PROMOTIONS_PROMPT);
  });

  // Similar user categories, a customized Promotions rule, or deleted defaults cannot be silently recreated or rewritten.
  it('leaves customized Promotions and unrelated categories intact without recreating deleted defaults', () => {
    const db = legacyDb();
    db.prepare("UPDATE ai_category_definitions SET prompt = ? WHERE slug = 'promotions'").run('Treat my opted-in vendor offers as promotions');
    db.exec("DELETE FROM ai_category_definitions WHERE slug = 'needs_response'");
    db.prepare(`INSERT INTO ai_category_definitions SELECT 'sales_work', name, description, ?, icon, color,
      sort_order, is_system, is_enabled, updated_at FROM ai_category_definitions WHERE slug = 'promotions'`)
      .run(LEGACY_PROMOTIONS_PROMPT);
    const before = categories(db);
    businessConversationCategories.up(db, {});
    expect(categories(db)).toEqual(before);
  });

  // A failed second update must roll back the first; retrying then applies both exactly once.
  it('rolls back an interrupted migration and permits a complete retry', () => {
    const db = legacyDb();
    const before = categories(db);
    db.exec(`CREATE TRIGGER fail_promotions BEFORE UPDATE ON ai_category_definitions
      WHEN NEW.slug = 'promotions' BEGIN SELECT RAISE(ABORT, 'interrupted update'); END;`);
    expect(() => manager(db).migrate()).toThrow('interrupted update');
    expect(categories(db)).toEqual(before);
    expect(manager(db).getCurrentVersion()).toBe(103);
    db.exec('DROP TRIGGER fail_promotions');
    manager(db).migrate();
    expect(categories(db).map((category) => category.prompt)).toEqual([NEEDS_RESPONSE_PROMPT, PROMOTIONS_PROMPT]);
    expect(manager(db).getCurrentVersion()).toBe(104);
  });

  // Each account owns its taxonomy; upgrading one must not overwrite another account's customized reply rule.
  it('keeps independent account prompts and post-upgrade edits through rollback', () => {
    const untouched = legacyDb();
    const custom = legacyDb();
    custom.prepare("UPDATE ai_category_definitions SET prompt = ? WHERE slug = 'needs_response'").run('Account B custom requests');
    manager(untouched).migrate();
    manager(custom).migrate();
    expect(categories(untouched)[0].prompt).toBe(NEEDS_RESPONSE_PROMPT);
    expect(categories(custom)[0].prompt).toBe('Account B custom requests');
    untouched.prepare("UPDATE ai_category_definitions SET prompt = ? WHERE slug = 'promotions'").run('Edited after upgrade');
    const before = categories(untouched);
    manager(untouched).rollback(103);
    expect(categories(untouched)).toEqual(before);
  });
});
