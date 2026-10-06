import { addTag, GMAIL_CLASSIFICATION_CATEGORY_SLUGS, parseTags, removeTag } from '@sarvinbox/core';

type SyncStatus = 'success' | 'queued' | 'local-only';
type QueueResult = 'success' | 'queued' | 'failed';
type Category = { slug: string; name?: string };

export interface ClassificationStorage {
  getEmail(id: string): Promise<{ id: string; uid?: number | null; folderId: string; tags?: string | null; gmailImportant?: boolean | null } | null>;
  getFolder(id: string): Promise<{ path: string } | null>;
  getCategoryDefinitions(): Category[];
  /** Atomically updates category tags and provenance, preserving all other tags. */
  setEmailManualCategories(id: string, categories: string[] | null): void;
  /** Gmail importance is a flag override, independent of category authority. */
  setEmailManualImportance?(id: string, on: boolean): void;
}

export interface ClassificationEngine {
  assertManualCategorySync(slug: string): void;
  markImportant(path: string, uid: number, on: boolean): Promise<QueueResult>;
  setCategorySelection(path: string, uid: number, data: CategoryOp): Promise<QueueResult>;
}

type CategoryOp = { apply: Array<{ slug: string; name: string }>; remove: Array<{ slug: string; name: string }>; host: string; mode: 'copy' };

const mutationTails = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Order automatic mirrors and explicit choices for this account's message. */
export function runClassificationMutation<T>(storage: object, emailId: string, run: () => Promise<T>): Promise<T> {
  let tails = mutationTails.get(storage);
  if (!tails) { tails = new Map(); mutationTails.set(storage, tails); }
  const previous = tails.get(emailId) ?? Promise.resolve();
  const job = previous.catch(() => undefined).then(run);
  tails.set(emailId, job);
  return job.finally(() => { if (tails.get(emailId) === job) tails.delete(emailId); });
}

/** Serialize this message's choices without blocking other accounts/messages. */
export function changeEmailCategory(
  storage: ClassificationStorage, engine: ClassificationEngine | null,
  emailId: string, slug: string, on: boolean,
): Promise<{ categories: string[]; syncStatus: SyncStatus }> {
  return runClassificationMutation(storage, emailId, () => performCategoryChange(storage, engine, emailId, slug, on));
}

/** Persist the server operation before reporting a manual choice as saved. */
async function performCategoryChange(
  storage: ClassificationStorage,
  engine: ClassificationEngine | null,
  emailId: string,
  slug: string,
  on: boolean,
): Promise<{ categories: string[]; syncStatus: SyncStatus }> {
  if (typeof on !== 'boolean') throw new Error('Category selection must be true or false');
  const definitions = [...storage.getCategoryDefinitions()];
  // Native provider assignments remain editable even after the user removed
  // their optional AI category definition.
  for (const native of ['important', ...GMAIL_CLASSIFICATION_CATEGORY_SLUGS]) {
    if (!definitions.some((category) => category.slug === native)) {
      definitions.push({ slug: native, name: native[0].toUpperCase() + native.slice(1) });
    }
  }
  const known = new Set(definitions.map((category) => category.slug));
  if (slug !== 'important' && !known.has(slug)) throw new Error('Category not found');
  known.add('important');
  const email = await storage.getEmail(emailId);
  if (!email) throw new Error('Email not found');
  const nextTags = on ? addTag(email.tags || '||', slug) : removeTag(email.tags || '||', slug);
  let categories = parseTags(nextTags).filter((tag) => known.has(tag));
  let syncStatus: SyncStatus = 'local-only';

  if (email.uid) {
    if (!engine) throw new Error('This account is not ready to queue label changes. Try again.');
    const folder = await storage.getFolder(email.folderId);
    if (!folder) throw new Error('The message folder is unavailable. Sync the mailbox and try again.');
    engine.assertManualCategorySync(slug);
    if (slug === 'important') {
      const result = await engine.markImportant(folder.path, email.uid, on);
      if (result === 'failed') throw new Error('Could not save the importance change for server sync.');
      syncStatus = result;
    } else {
      // A queued type+folder+UID is coalesced. Send the complete desired and
      // removed sets so multiple selections made offline cannot lose a label.
      const desired = new Set(categories);
      const label = (category: Category) => ({ slug: category.slug, name: category.name || category.slug });
      const data = { host: '', mode: 'copy' as const };
      const apply = definitions.filter((category) => category.slug !== 'important' && desired.has(category.slug)).map(label);
      const remove = definitions.filter((category) => category.slug !== 'important' && !desired.has(category.slug)).map(label);
      // One durable operation stores the entire intent before either server
      // step runs. A failed second enqueue must never leave a removal behind.
      const result = await engine.setCategorySelection(folder.path, email.uid, { ...data, apply, remove });
      if (result === 'failed') throw new Error('Could not save the category change for server sync.');
      syncStatus = result;
    }
  }

  // The manual projection is distinct from an AI verdict. Its empty array is
  // intentional: automatic categorization must not put cleared labels back.
  const latest = await storage.getEmail(emailId);
  if (!latest) throw new Error('Email no longer exists');
  if (slug === 'important') {
    // Importance is the only state sent for this operation. Preserve any
    // category refresh that arrived while it was queued.
    const latestTags = on ? addTag(latest.tags || '||', slug) : removeTag(latest.tags || '||', slug);
    categories = parseTags(latestTags).filter((tag) => known.has(tag));
  } else {
    // Keep the full queued category snapshot authoritative. Only importance
    // may change independently; ordinary tags are preserved by the setter.
    categories = categories.filter((tag) => tag !== 'important');
    if (parseTags(latest.tags || '||').includes('important')) categories.push('important');
  }
  if (latest.gmailImportant != null) {
    // Changing Gmail's importance marker must not freeze its AI category.
    if (slug === 'important') {
      if (!storage.setEmailManualImportance) throw new Error('Importance storage is unavailable');
      storage.setEmailManualImportance(emailId, on);
    } else {
      storage.setEmailManualCategories(emailId, categories.filter((tag) => tag !== 'important'));
    }
  } else {
    storage.setEmailManualCategories(emailId, categories);
  }
  return { categories, syncStatus };
}
