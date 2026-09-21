# `@sarv-in/mailguard`

The mail-security rules this app used to carry in `packages/core` and
`apps/desktop` — SPF/DKIM/DMARC header reading, display-name impersonation,
origin-IP extraction, the header-stage spam scorer and its verdict codec,
deceptive-link detection and the five security levels — now live in an
open-source library:

- source: <https://github.com/Sarv/mailguard>
- package: `@sarv-in/mailguard`

Nothing about the rules changed in the move. What changed is that they can be
read, tested and contributed to by people who do not have this repository, and
that the sync-time filter and the renderer's shield are provably the same code
rather than two copies that agree today.

## What stayed behind, and why

| Stayed                                 | Where                                      | Why                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LEVEL_COPY`                           | `apps/desktop/src/utils/email-security.ts` | Product copy. The library returns a level; only this app knows how it addresses its reader.                                                                                  |
| `firstFlaggedEmailId`                  | same file                                  | A thread-view policy ("one banner, on the first message that warrants it"), not a mail-security rule.                                                                        |
| `assessBulkMail` and the CONTENT layer | `packages/core/src/utils/bulk-mail.ts`     | Scores this app's stored body and tag string. The HEADER layer it defers to moved and is re-exported from there.                                                             |
| `hasReplyPrefix`                       | `packages/core/src/utils/validators.ts`    | Derived from `normalizeSubject` and consumed by `storage-node`'s thread resolver. The library carries its own internal copy for scoring; the two answer different questions. |

Both `packages/core/src/utils/index.ts` and the desktop's
`email-security.ts` re-export the moved names under the names they always had,
so no caller in this repo had to learn a new import path.

## Which entry point to import

The library publishes browser-safe subpaths so the renderer bundle never pulls
in anything Node-only:

| Entry point                     | Use it for                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sarv-in/mailguard`            | Everything. Main process / core only.                                                                                                                                                                                                                             |
| `@sarv-in/mailguard/headers`    | Reading raw header text: `headerLookupFromText`, `bulkHeaderSignals`, the auth-header reader. Zero dependencies.                                                                                                                                                  |
| `@sarv-in/mailguard/verdict`    | Thresholds, `spamVerdict`, `parseSpamReasons`, `AuthStatus`.                                                                                                                                                                                                      |
| `@sarv-in/mailguard/identity`   | `registrableDomain`, `domainsInText`, `assessSender`.                                                                                                                                                                                                             |
| `@sarv-in/mailguard/links`      | `linkMismatches`, `assessLinks`, `assessPhishing`, and `linkDomains` — the domains a body links TO, which the reputation body stage looks up.                                                                                                                     |
| `@sarv-in/mailguard/security`   | `assessEmailSecurity` and the level model.                                                                                                                                                                                                                        |
| `@sarv-in/mailguard/reputation` | The blocklist catalogue and the DNSBL lookup. `BlocklistsTab.tsx` imports it for the catalogue: it reaches `node:dns` only through a dynamic import, and its one third-party cost, `ipaddr.js`, is CommonJS and therefore named in `LINKED_CJS_DEPS` (see below). |

**A module aliased into the renderer must import from a subpath, never the
root.** `packages/core/src/utils/bulk-mail.ts` is aliased straight into the
browser bundle (`apps/desktop/vite/renderer-aliases.ts`), so whatever it
imports, the browser imports. Pointing it at the root entry on 2026-09-19 gave
a blank window: the root pulls in `free-email-domains`, a CommonJS array with
no default export that the Vite dev server serves unconverted. The production
build converted it happily, so `check:renderer-bundle` stayed green and nothing
failed until someone ran `pnpm dev:desktop`. Two tests now guard it — the
library pins each entry's dependency list, and
`apps/desktop/vite/forbid-node-only-renderer.ts` fails the build if that corpus
reaches the renderer graph again.

**A CommonJS dependency the renderer reaches through the library has to be
named in `LINKED_CJS_DEPS`.** The linked package is excluded from Vite's
pre-bundle so a rebuild of it is visible in dev, and that exclusion covers its
dependencies too: Vite hands them to the browser exactly as they sit on disk.
An ESM one is fine; a CommonJS one arrives as `module.exports = ...` and the
`import x from 'pkg'` that wanted it throws. Same blank window, same dev-only
shape as `free-email-domains`. Naming it in `LINKED_CJS_DEPS`
(`apps/desktop/vite/linked-packages.ts`) puts that one package back in the
pre-bundle, where esbuild converts it. `BlocklistsTab.tsx` is why `ipaddr.js`
is on that list, and the test beside it walks the renderer's imports through
the library's built ESM so the next such import fails a test rather than a
dev-server start.

## Blocklists: the one check that leaves the machine

Every other stage reads the message that already arrived. The reputation stage
asks a DNSBL operator, over DNS, about the IP that delivered the message and
the registrable domain it claims to be from — so the operator learns, in near
real time, who writes to this user. It is **off** until the user turns it on in
**Security > Blocklists**, and there is no default zone list.

Three pieces make it work in a mail client rather than a batch scanner, and
they live in `packages/core/src/imap/reputation-stage.ts`:

- **A cache.** A mailing list delivers from the same handful of IPs all day.
- **In-flight de-duplication.** A batch of twenty messages from one sender is
  one query, not twenty.
- **A circuit breaker.** This is the desktop-specific one. Spamhaus and its
  peers _refuse_ queries that arrive through a public or open resolver — which
  is what an ISP's DNS, or 8.8.8.8, is, and therefore what most consumer
  machines have. The refusal is an answer (`127.255.255.254`), not a listing;
  the library reads it as a refusal, and the breaker stops us hammering a zone
  that will never answer. This is why the settings tab asks for resolvers, and
  says why.

Where each part sits:

| Piece                                                | File                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| Cache, de-duplication, breaker                       | `packages/core/src/imap/reputation-stage.ts`             |
| The `await` that must happen before the re-file      | `message-processor.ts`, in `convertMessage`              |
| One stage for the whole process, built from settings | `apps/desktop/electron/services/reputation-service.ts`   |
| The settings tab                                     | `apps/desktop/src/components/security/BlocklistsTab.tsx` |

Two constraints on the ingest side are load-bearing:

- The lookup is awaited **inside `convertMessage`, before the spam tag and
  before the re-file**. Scoring it afterwards would show the user a message
  land in the inbox and then leave it.
- It is withheld in `quiet` mode, alongside the known-spammer lookup and the AI
  pipeline. A historical backfill of a large mailbox must never become tens of
  thousands of DNS queries sent to an operator on the user's behalf.

`headerStage` stays pure and synchronous. The header backfill shares it, so
both paths reach the same verdict from the same evidence; the DNS happens one
level up, where only ingest runs.

## Local development vs. release

The dependency is declared in two places — `packages/core/package.json` and
`apps/desktop/package.json` — and both must say the same thing.

**Working on the library**: point at the sibling checkout.

```json
"@sarv-in/mailguard": "file:../../../mailguard"
```

with the package name listed in `apps/desktop/vite/linked-packages.ts`:

```ts
export const LINKED_PACKAGES: readonly string[] = ['@sarv-in/mailguard'];
```

That second step is not optional. With `node-linker=hoisted`, pnpm HARDLINKS a
`file:` dependency into `node_modules` instead of symlinking it, so Vite's own
linked-dependency detection never fires: it pre-bundles the library once and
its watcher skips the directory. Rebuild the library and the dev server keeps
serving the previous copy, with no error, no warning and no reload. A test
asserts the list matches exactly the dependencies whose range starts with
`file:`, so the two cannot drift.

After editing either `package.json`, run `pnpm install` at the repo root, and
run `pnpm build` inside the library checkout after changing its source — the
`file:` dependency resolves to `dist/`, not `src/`.

**Releasing** (the current state): point at the registry and empty the list.

```json
"@sarv-in/mailguard": "^0.1.0"
```

```ts
export const LINKED_PACKAGES: readonly string[] = [];
```

Vite's default handling — pre-bundle once, never watch — is exactly right for
an immutable published tarball, and excluding it would only cost dev-server
startup time. This is where the dependency sits today: `@sarv-in/mailguard`
was published to npm in Sept 2026, joining `@sarv-in/email-chat-view`, and both
now install from the registry. That is also what makes CI work at all — a
`file:` range resolves to a directory that a fresh checkout of this repo alone
does not have, so `pnpm install --frozen-lockfile` could not have succeeded.
