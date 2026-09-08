/* Types for stale-js.mjs — see userdata-dirs.d.mts for why these exist. */

/** Delete `.js` files that still have a `.ts`/`.tsx` sibling. */
export declare function cleanStaleJs(roots: string[]): { removed: string[] };
