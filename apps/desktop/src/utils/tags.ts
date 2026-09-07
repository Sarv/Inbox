// Renderer-side tag-string helpers. Mirrors packages/core/src/utils/tags.ts —
// duplicated deliberately because the renderer can't import @sarvinbox/core's
// barrel at runtime (it drags Node deps into the Vite bundle). Keep in sync.
// Tags are stored as a `|a|b|c|` string.

/** Build a tags string from an array of tag names. */
export function buildTags(tagList: string[]): string {
  if (tagList.length === 0) return '||';
  return `|${tagList.join('|')}|`;
}

/** Parse a tags string into an array of tag names. */
export function parseTags(tags: string): string[] {
  if (!tags || tags === '||') return [];
  return tags.split('|').filter((t) => t.length > 0);
}

/** Check if a tags string contains a specific tag. */
export function hasTag(tags: string | null | undefined, tag: string): boolean {
  return (tags || '').includes(`|${tag}|`);
}

/** Add a tag to a tags string (idempotent). */
export function addTag(tags: string, tag: string): string {
  if (hasTag(tags, tag)) return tags;
  const list = parseTags(tags);
  list.push(tag);
  return buildTags(list);
}

/** Remove a tag from a tags string. */
export function removeTag(tags: string, tag: string): string {
  return buildTags(parseTags(tags).filter((t) => t !== tag));
}
