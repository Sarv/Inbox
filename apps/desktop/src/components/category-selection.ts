/** Only explicit checkbox changes are submitted; unrelated categories stay applied. */
export function categorySelectionChanges(applied: ReadonlySet<string>, pending: ReadonlySet<string>): Array<{ slug: string; on: boolean }> {
  return [...new Set([...applied, ...pending])]
    .filter((slug) => applied.has(slug) !== pending.has(slug))
    .map((slug) => ({ slug, on: pending.has(slug) }));
}
