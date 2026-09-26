// The download page is plain browser JavaScript (src), tested in Node with a
// happy-dom `document` (test), plus Node build scripts.
module.exports = {
  env: { browser: true, node: true, es2023: true },
  parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
  rules: {
    // bowser's TypeScript types declare named exports its JavaScript does not
    // have: at runtime (Node's CJS build and Vite's `module` build alike) it is
    // a single default-exported class. `import Bowser from 'bowser'` is the only
    // import that works, and these two rules, reading the types, flag it.
    'import/default': 'off',
    'import/no-named-as-default-member': 'off',
  },
};
