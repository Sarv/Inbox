import { addTag, parseTags, removeTag } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { changeEmailCategory, runClassificationMutation } from '../../../../electron/services/classification-actions';

const nativeRest = [
  { slug: 'social', name: 'Social' }, { slug: 'updates', name: 'Updates' },
  { slug: 'forums', name: 'Forums' }, { slug: 'personal', name: 'Primary' },
];
const definitions = [
  { slug: 'important', name: 'Important' },
  { slug: 'promotions', name: 'Promotions' },
  { slug: 'finance', name: 'Finance' },
  ...nativeRest,
];
let email: { id: string; uid: number | null; folderId: string; tags: string };
const storage = {
  getEmail: vi.fn(async () => email),
  getFolder: vi.fn(async () => ({ path: 'INBOX' })),
  getCategoryDefinitions: vi.fn(() => definitions),
  updateEmail: vi.fn(async (_id: string, updates: { tags: string }) => { email.tags = updates.tags; }),
  setEmailManualCategories: vi.fn(),
};
const engine = {
  assertManualCategorySync: vi.fn(),
  markImportant: vi.fn(async (_path: string, _uid: number, _on: boolean): Promise<'queued' | 'success' | 'failed'> => 'queued'),
  setCategorySelection: vi.fn(async (): Promise<'queued' | 'success' | 'failed'> => 'queued'),
};

beforeEach(() => {
  vi.clearAllMocks();
  email = { id: 'message', uid: 1413, folderId: 'inbox', tags: '|INBOX|read|promotions|Personal|' };
  storage.getEmail.mockImplementation(async () => email);
  storage.getFolder.mockImplementation(async () => ({ path: 'INBOX' }));
  storage.getCategoryDefinitions.mockImplementation(() => definitions);
  engine.markImportant.mockImplementation(async () => 'queued');
  engine.setCategorySelection.mockImplementation(async () => 'queued');
  engine.assertManualCategorySync.mockImplementation(() => undefined);
  storage.setEmailManualCategories.mockImplementation((_id, categories: string[]) => {
    for (const definition of definitions) email.tags = removeTag(email.tags, definition.slug);
    for (const slug of categories) email.tags = addTag(email.tags, slug);
  });
});

describe('manual classification sync', () => {
  // Regression: a Sarv importance click must reach its own UID and keep Promotions, stars and custom labels.
  it('queues native importance before saving its independent local projection', async () => {
    const result = await changeEmailCategory(storage, engine, 'message', 'important', true);
    expect(engine.markImportant).toHaveBeenCalledWith('INBOX', 1413, true);
    expect(engine.markImportant.mock.invocationCallOrder[0]).toBeLessThan(storage.setEmailManualCategories.mock.invocationCallOrder[0]);
    expect(result).toEqual({ categories: ['promotions', 'important'], syncStatus: 'queued' });
    expect(email.tags).toContain('|promotions|');
    expect(email.tags).toContain('|Personal|');
    expect(email.tags).toContain('|read|');
    expect(engine.setCategorySelection).not.toHaveBeenCalled();
  });

  // Regression: a read/star/custom-label update arriving during server sync must not be overwritten.
  it('preserves concurrent ordinary tags and serializes the last importance choice', async () => {
    engine.markImportant.mockImplementation(async () => { email.tags = addTag(email.tags, 'starred'); return 'queued'; });
    await Promise.all([
      changeEmailCategory(storage, engine, 'message', 'important', true),
      changeEmailCategory(storage, engine, 'message', 'important', false),
    ]);
    expect(parseTags(email.tags)).toEqual(expect.arrayContaining(['starred', 'promotions', 'Personal', 'read']));
    expect(parseTags(email.tags)).not.toContain('important');
    expect(engine.markImportant.mock.calls.map((call) => call[2])).toEqual([true, false]);
  });

  // Regression: offline selections would overwrite earlier category payloads in the type+folder+UID queue.
  it('queues complete category snapshots for successive offline changes', async () => {
    await changeEmailCategory(storage, engine, 'message', 'finance', true);
    expect(engine.setCategorySelection).toHaveBeenLastCalledWith('INBOX', 1413, {
      apply: [definitions[1], definitions[2]], remove: nativeRest, host: '', mode: 'copy',
    });
    await changeEmailCategory(storage, engine, 'message', 'promotions', false);
    expect(engine.setCategorySelection).toHaveBeenLastCalledWith('INBOX', 1413, {
      apply: [definitions[2]], remove: [definitions[1], ...nativeRest], host: '', mode: 'copy',
    });
    expect(email.tags).toContain('|Personal|');
  });

  // Regression: a provider update during enqueue must not make the local selection disagree with the queued snapshot.
  it('keeps queued categories while preserving a concurrent native importance flag', async () => {
    engine.setCategorySelection.mockImplementationOnce(async () => {
      email.tags = '|INBOX|read|important|starred|';
      return 'queued';
    });
    const result = await changeEmailCategory(storage, engine, 'message', 'finance', true);
    expect(result.categories).toEqual(['promotions', 'finance', 'important']);
    expect(parseTags(email.tags)).toEqual(expect.arrayContaining(['read', 'starred', 'important', 'promotions', 'finance']));
    expect(engine.setCategorySelection).toHaveBeenCalledWith('INBOX', 1413, {
      apply: [definitions[1], definitions[2]], remove: nativeRest, host: '', mode: 'copy',
    });
  });

  // Regression: server removal and an intentional empty selection must not get re-added by AI.
  it('saves an explicit empty override when the final category is removed', async () => {
    await changeEmailCategory(storage, engine, 'message', 'promotions', false);
    expect(storage.setEmailManualCategories).toHaveBeenCalledWith('message', []);
    expect(engine.setCategorySelection).toHaveBeenCalledWith('INBOX', 1413, { apply: [], remove: [definitions[1], definitions[2], ...nativeRest], host: '', mode: 'copy' });
  });

  // Regression: a failed durable enqueue must never appear as a successfully saved server change.
  it('does not change local tags when queue persistence fails', async () => {
    engine.markImportant.mockRejectedValueOnce(new Error('database locked'));
    await expect(changeEmailCategory(storage, engine, 'message', 'important', true)).rejects.toThrow('database locked');
    expect(storage.updateEmail).not.toHaveBeenCalled();
    expect(storage.setEmailManualCategories).not.toHaveBeenCalled();
  });

  // Regression: a permanent rejected server operation must report failure, not look saved.
  it('reports failed queue results and successful immediate results distinctly', async () => {
    engine.markImportant.mockResolvedValueOnce('failed');
    await expect(changeEmailCategory(storage, engine, 'message', 'important', true)).rejects.toThrow('importance change');
    engine.setCategorySelection.mockResolvedValueOnce('failed');
    await expect(changeEmailCategory(storage, engine, 'message', 'finance', true)).rejects.toThrow('category change');
    expect(storage.updateEmail).not.toHaveBeenCalled();
    engine.markImportant.mockResolvedValueOnce('success');
    expect((await changeEmailCategory(storage, engine, 'message', 'important', true)).syncStatus).toBe('success');
    engine.setCategorySelection.mockResolvedValueOnce('success');
    expect((await changeEmailCategory(storage, engine, 'message', 'finance', true)).syncStatus).toBe('success');
  });

  // Regression: unavailable account/folder must not silently switch to another mailbox or skip sync.
  it('refuses a remote mutation without its engine or original folder', async () => {
    await expect(changeEmailCategory(storage, null, 'message', 'important', true)).rejects.toThrow('not ready');
    storage.getFolder.mockResolvedValueOnce(null as never);
    await expect(changeEmailCategory(storage, engine, 'message', 'important', true)).rejects.toThrow('folder is unavailable');
    expect(storage.updateEmail).not.toHaveBeenCalled();
  });

  // Regression: unsupported native-tab or folder writes must not be reported as saved.
  it('rejects an unsupported server before creating operations or changing local categories', async () => {
    engine.assertManualCategorySync.mockImplementationOnce(() => { throw new Error('Sign in with Gmail OAuth to change built-in categories'); });
    await expect(changeEmailCategory(storage, engine, 'message', 'promotions', false)).rejects.toThrow('Gmail OAuth');
    expect(engine.setCategorySelection).not.toHaveBeenCalled();
    expect(storage.setEmailManualCategories).not.toHaveBeenCalled();
  });

  // Regression: unsent/local messages have no server UID and still need durable manual choices.
  it('allows a local-only message and rejects malformed or unknown selections', async () => {
    email.uid = null;
    expect((await changeEmailCategory(storage, null, 'message', 'important', true)).syncStatus).toBe('local-only');
    await expect(changeEmailCategory(storage, null, 'message', 'unknown', true)).rejects.toThrow('Category not found');
    await expect(changeEmailCategory(storage, null, 'message', 'important', 'yes' as never)).rejects.toThrow('true or false');
    storage.getEmail.mockResolvedValueOnce(null as never);
    await expect(changeEmailCategory(storage, null, 'message', 'important', true)).rejects.toThrow('Email not found');
  });

  // Regression: missing legacy tags/display names still need a valid queued snapshot and independent importance.
  it('normalizes empty legacy metadata and reports deletion during a save', async () => {
    email.tags = '';
    storage.getCategoryDefinitions.mockReturnValueOnce([{ slug: 'finance', name: '' }]);
    await changeEmailCategory(storage, engine, 'message', 'finance', true);
    expect(engine.setCategorySelection).toHaveBeenCalledWith('INBOX', 1413, {
      apply: [{ slug: 'finance', name: 'finance' }], remove: [definitions[1], ...nativeRest], host: '', mode: 'copy',
    });
    email.tags = '';
    await changeEmailCategory(storage, engine, 'message', 'important', false);
    email.tags = '';
    await changeEmailCategory(storage, engine, 'message', 'important', true);
    storage.getEmail.mockResolvedValueOnce(email).mockResolvedValueOnce(null as never);
    await expect(changeEmailCategory(storage, engine, 'message', 'important', true)).rejects.toThrow('no longer exists');
  });

  // Regression: deleting an AI definition must not make the provider's existing native category impossible to remove.
  it('keeps native provider assignments editable without AI definitions', async () => {
    storage.getCategoryDefinitions.mockReturnValueOnce([]);
    email.tags = '|INBOX|read|forums|';
    const result = await changeEmailCategory(storage, engine, 'message', 'forums', false);
    expect(result.categories).toEqual([]);
    expect(engine.setCategorySelection).toHaveBeenCalledWith('INBOX', 1413, {
      apply: [], remove: [definitions[1], ...nativeRest], host: '', mode: 'copy',
    });
  });
});


it('releases a failed mirror so a later explicit choice can run on the same account/message', async () => {
  const order: string[] = [];
  const first = runClassificationMutation(storage, 'message', async () => {
    order.push('mirror');
    throw new Error('Mirror unavailable');
  });
  const second = runClassificationMutation(storage, 'message', async () => { order.push('manual'); return 'saved'; });
  await expect(first).rejects.toThrow('Mirror unavailable');
  await expect(second).resolves.toBe('saved');
  expect(order).toEqual(['mirror', 'manual']);
});
