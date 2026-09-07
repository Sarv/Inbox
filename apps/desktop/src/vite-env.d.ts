/// <reference types="vite/client" />

// Brings in Vite's ambient types for the renderer — notably `ImportMeta.env`
// (`import.meta.env.DEV`, used by src/sentry.ts to tag the Sentry environment).
// Vite injects those values at build time, but the typings only exist if this
// reference is present, so without this file `tsc` fails with
// "Property 'env' does not exist on type 'ImportMeta'". The `pnpm build` /
// `pnpm build:internal` pipelines run `tsc` as a gate, so that error blocks a
// packaged build even though `vite build` alone would have succeeded.
