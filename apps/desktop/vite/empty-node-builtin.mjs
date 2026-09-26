// The empty module a browser bundler substitutes for a Node builtin.
//
// Not a stub with fake behaviour and not a thrower: packages routed here declare
// the builtin OPTIONAL in their own package.json `browser` field (postcss ships
// `"browser": { "path": false, "url": false, "fs": false }`) and test for it
// before use — postcss's `pathAvailable = Boolean(resolve && isAbsolute)`. An
// object with no properties is exactly what `false` means there, and it is what
// webpack/esbuild/rollup hand those packages everywhere else.
//
// Nothing else resolves here: see vite/browser-safe-builtins.ts for the
// per-importer allow-list that decides who gets this file.
export default {};
