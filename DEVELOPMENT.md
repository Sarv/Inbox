# Development Guide

## Prerequisites

### Node.js Version

**Important**: This project targets Node.js v24 (LTS). The `.nvmrc` pins it and `engines` requires Node >= 22.

`better-sqlite3` v12 ships prebuilt binaries for Node 24 (ABI 137), so no source compilation is needed. (Note: `better-sqlite3` v12 drops prebuilds for Node 18/20 — stay on Node 22 or 24.)

```bash
# Using nvm (recommended) — picks up .nvmrc
nvm install 24
nvm use

# Or using n
n 24

# Verify version
node --version  # Should show v24.x.x
```

### Package Manager

This project uses pnpm for faster installs and better disk efficiency:

```bash
npm install -g pnpm
```

## Setup

1. **Clone and install**:
   ```bash
   git clone https://github.com/Sarv/Inbox.git
   cd Inbox
   pnpm install
   ```

2. **Build the libraries**:
   ```bash
   pnpm build:core
   pnpm --filter @sarvinbox/storage-node build
   ```
   (`pnpm build` also packages the desktop app with `electron-builder`, which
   needs signing assets — you don't need it for development.)

3. **Run type checking**:
   ```bash
   pnpm type-check
   ```

4. **Run tests**:
   ```bash
   pnpm test
   ```

## Development Workflow

### Watch Mode

Run packages in watch mode during development:

```bash
# Watch core package (in terminal 1)
pnpm dev:core

# Run desktop app (in terminal 2)
pnpm dev:desktop
```

### Building

```bash
# Build a specific package
pnpm --filter @sarvinbox/core build
pnpm --filter @sarvinbox/storage-node build

# Build everything and package the desktop app (needs signing assets)
pnpm build
```

### Testing

```bash
# Run all tests
pnpm test

# Run all tests with a coverage report
pnpm test:coverage

# Run tests in watch mode
pnpm test:watch

# Run tests for specific package
pnpm --filter @sarvinbox/core test
```

Straight after `pnpm install`, the SQLite-backed suites fail with
`ERR_DLOPEN_FAILED`: postinstall builds `better-sqlite3` for Electron's ABI,
while the tests run in plain Node. Flip it with `pnpm test:node-abi`, and back
with `node scripts/native-abi.mjs electron` (or `sh scripts/dev.sh`).

See [docs/TESTING.md](docs/TESTING.md) for the test layers, the in-memory IMAP
server used by sync tests, and the house rules for writing new tests.

### Linting & Formatting

```bash
# Lint all packages
pnpm lint

# Fix lint errors
pnpm lint:fix

# Format code
pnpm format

# Check formatting
pnpm format:check
```

## Package Structure

```
Inbox/
├── packages/
│   ├── core/              # Platform-agnostic business logic
│   ├── storage-node/      # Desktop SQLite (better-sqlite3)
│   ├── storage-mobile/    # Same storage contract on op-sqlite (for a future mobile app)
│   ├── ui-shared/         # Shared React hooks & logic
│   └── ui-primitives/     # Platform-specific UI wrappers
│
└── apps/
    └── desktop/           # Electron app
```

## Common Issues

### better-sqlite3 compilation fails

**Problem**: `better-sqlite3` falls back to source compilation (no matching prebuilt binary for your Node version)

**Solution**: Use a Node version with prebuilds (22 or 24 LTS):
```bash
nvm use   # picks up .nvmrc (v24)
rm -rf node_modules
pnpm install
```

### Type errors in IDE

**Problem**: IDE shows type errors for workspace packages

**Solution**: Build the core package first:
```bash
pnpm --filter @sarvinbox/core build
```

### Turborepo cache issues

**Problem**: Changes not reflected after rebuild

**Solution**: Clear turbo cache:
```bash
rm -rf .turbo
pnpm build:core
```

## Debugging

### VSCode Configuration

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Desktop App",
      "cwd": "${workspaceFolder}/apps/desktop",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dev"],
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

### Logging

The main process logs at `debug` in dev and `info` in release builds. Override
the level with `SARV_LOG_LEVEL` (environment or `.env`):

```bash
SARV_LOG_LEVEL=trace pnpm dev:desktop   # trace | debug | info | warn | error
```

In dev the console is also tee'd to a rolling `app.log` in the userData
directory — see "Debug logging" in the [README](./README.md#debug-logging) for
the per-OS paths.

## Git Workflow

1. Create feature branch:
   ```bash
   git checkout -b feat/my-feature
   ```

2. Make changes and commit:
   ```bash
   git add .
   git commit -m "feat(scope): add my feature"
   ```

3. Push and create PR:
   ```bash
   git push origin feat/my-feature
   ```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the commit format and PR checklist.

## Release Process

Releases are cut manually by a maintainer. CI (`.github/workflows/ci.yml`) runs
type-check, lint, the renderer-bundle guard, the test suites and a dependency
audit on every push and pull request — it does **not** build or publish release
artifacts.

1. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and date.
2. Run `pnpm release` (or `release:patch` / `release:minor` / `release:major`).
   `scripts/release.sh` bumps the version, commits, and builds the signed macOS
   package; `scripts/release_github.sh` additionally notarizes it, creates the
   release commit + tag, pushes, and publishes a GitHub release with the DMG(s).
   Both need Apple code-signing and notarization credentials that only
   maintainers hold — contributors never need to run them.

## Resources

- [pnpm workspaces](https://pnpm.io/workspaces)
- [Turbo](https://turbo.build/repo/docs)
- [Electron](https://www.electronjs.org/docs/latest/)
- [React Native](https://reactnative.dev/docs/getting-started)
