// `@sarvinbox/core/pgp` — a separate entry point on purpose. openpgp.js is a
// large library that only the main process needs; kept out of the main barrel,
// it never reaches the renderer bundle or the mobile build. Types are plain
// data, so the renderer can still `import type` from here.
export * from './pgp/index';
