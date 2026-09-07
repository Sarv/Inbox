module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  plugins: ['@typescript-eslint', 'import', 'react-hooks'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    // Some modules use intentional lazy `require()` to break import cycles
    // (e.g. storage-node ↔ email-repository tag helpers); keep it visible as a
    // warning rather than a build-blocking error.
    '@typescript-eslint/no-var-requires': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-unresolved': 'off', // TypeScript handles this
    // Same rationale: with our `export *` barrels the import plugin double-counts
    // re-exports through the TS resolver and reports phantom "multiple exports"
    // even when a type is declared once. TypeScript is the source of truth for
    // real export conflicts, so keep this visible as a warning, not an error.
    'import/export': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    // Empty catch blocks are an intentional "best-effort, ignore failure"
    // pattern throughout the app (optional enrichment, localStorage probes).
    'no-empty': ['error', { allowEmptyCatch: true }],
    // React Hooks correctness. rules-of-hooks catches conditional/looped hook
    // calls (a real crash); exhaustive-deps stays a warning because the codebase
    // has intentional, reviewed dependency omissions marked with inline disables.
    // Non-React packages (packages/core, electron main) call no hooks, so these
    // are inert there.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  overrides: [
    {
      // RENDERER source only (not the Electron main process under
      // apps/desktop/electron/**, nor the packages/** libraries — those may use
      // the barrel). A VALUE import of the '@sarvinbox/core' barrel drags its
      // Node-only re-exports (imapflow / mailparser / nodemailer) into the
      // renderer bundle and crashes the packaged app on startup with
      // 'Dynamic require of "stream" is not supported'. `import type` is erased by
      // the compiler and stays safe, so it's allowed. This is the earliest of the
      // three defenses (editor/lint); the vite build guard and the CI
      // check:renderer-bundle step are the build-time backstops.
      files: ['apps/desktop/src/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@sarvinbox/core',
                allowTypeImports: true,
                message:
                  "Do not value-import the '@sarvinbox/core' barrel from the renderer — it bundles Node-only imapflow/mailparser/nodemailer and crashes the app on startup. Use `import type`, or deep-import a renderer-safe subpath (e.g. '@sarvinbox/core/contact-enrichment').",
              },
            ],
          },
        ],
      },
    },
  ],
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.base.json',
      },
    },
  },
  env: {
    node: true,
    es6: true,
  },
};
