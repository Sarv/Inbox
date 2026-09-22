# Writing a Sarv Inbox extension

An extension is a folder with a manifest and, usually, one CommonJS file. Sarv
Inbox runs that file in a **separate process** it starts for the purpose, hands
it a context object, and lets it act on mail as it arrives — tag it, star it,
ask the AI about it, or put a card on screen. An extension that crashes or
loops takes down nothing but itself.

An extension can also contribute a **panel**: a page of its own, shown beside
the open message or as a dialog. A panel needs no build step and no background
code at all — an `index.html` in a folder is a complete extension. See
[Panels](#panels).

**Extensions do not live in this repository.** They are published to
[Sarv/SarvInbox-extensions](https://github.com/Sarv/SarvInbox-extensions),
which serves a registry index, and the app installs them from there —
including the ones it ships with. That repository's README is the full
author-and-publish guide; this document is the host side of the contract: what
the app gives an extension, what it will and will not let one do, and how an
install is verified.

Three extensions are published today, and this build installs the first two on
first run:

| Extension | What it does | Permissions |
| --- | --- | --- |
| `otp-code` | Finds a verification code and shows it on a card with a copy button and a countdown | `email:read`, `email:label`, `storage:local`, `settings:read`, `ui:notify` |
| `vip-scoring` | Learns who you actually correspond with and tags their mail | `email:read`, `email:label`, `storage:local`, `settings:read` |
| `email-summarization` | Summarizes a long message or a whole thread | `email:read`, `ai:use`, `storage:local`, `settings:read` |

They are ordinary extensions, not special cases — the same loader, the same
permission checks, the same registry. Read one alongside this document; each
has its own README.

---

## Quick start

```
my-extension/
  sarvinbox-extension.json   # the manifest — required
  dist/index.js              # the built entry point — required, unless the
                             #   extension is only a panel (see Panels)
  icon.svg                   # optional
  README.md                  # optional
  src/index.ts               # your source (not shipped)
```

**1. The manifest**, `sarvinbox-extension.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "What it does, in one line",
  "author": "You",
  "main": "./dist/index.js",
  "icon": "./icon.svg",
  "engines": { "sarvinbox": "^1.1.0" },
  "permissions": ["email:read", "email:label"],
  "contributes": {
    "workflows": [
      {
        "id": "tag-newsletters",
        "name": "Tag newsletters",
        "description": "Tags mail that looks like a newsletter",
        "priority": 50
      }
    ],
    "settings": [
      {
        "key": "my-extension.enabled",
        "type": "boolean",
        "default": true,
        "description": "Enable this extension"
      }
    ]
  }
}
```

`id` must match the folder name and prefix every setting key. `contributes` is
a declaration of intent — the Extensions panel renders it before the extension
ever runs — and `activate` still has to register the workflow for real.

**2. The entry point.** Export `activate`, and `deactivate` if you hold
anything that needs releasing:

```ts
import type { EmailRecord, ExtensionContext, ExtensionWorkflowResult } from '@sarvinbox/core';

export function activate(context: ExtensionContext): void {
  context.registerWorkflow({
    id: 'tag-newsletters',
    name: 'Tag newsletters',
    priority: 50,

    shouldProcess: (email: EmailRecord): boolean =>
      context.settings.get<boolean>('my-extension.enabled', true) !== false,

    process: async (email: EmailRecord): Promise<ExtensionWorkflowResult> => {
      if (!/newsletter|digest|weekly/i.test(email.subject ?? '')) return { success: true };
      return { success: true, labelsToAdd: ['newsletter'] };
    },
  });
}

export function deactivate(): void {
  // Anything not registered through `context` — a timer, a watcher — is yours
  // to stop. Workflows and `context.subscriptions` are cleaned up for you.
}
```

**3. Build it to one file.** The host calls `require()` on `main` from wherever
the folder happens to sit — a checkout, an unpacked resources directory, a
folder in Downloads. None of those have a `node_modules` beside them, so the
entry point must carry everything it needs:

```ts
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: [/.*/], // nothing may be left as an external require
});
```

**4. Install it.** Settings -> Extensions -> **Install Extension**, and pick the folder. The
app validates the manifest, copies the folder into its own extensions
directory, and activates it. From then on the copy is what runs — reinstall
after a rebuild while you are developing.

---

## Permissions

Declared in the manifest, shown to the user before install, and enforced in the
main process at the point of effect — not in the sandbox, which only makes an
authoring mistake fail where it was written.

| Permission | Grants |
| --- | --- |
| `email:read` | Read subject, body and headers — the message being processed, and any message by id through `context.mail` |
| `email:label` | Add and remove labels/tags, on arrival or on demand |
| `email:flag` | Change `read` and `starred` |
| `email:move` | Move messages between folders |
| `email:delete` | Move messages to the trash folder — never an expunge |
| `ai:use` | `context.ai` — categorize, summarize, and raw completions |
| `storage:local` | `context.storage` — a private JSON store under the app's data directory |
| `network:fetch` | Outbound HTTP |
| `settings:read` | Read settings, including the ones the manifest contributes |
| `settings:write` | Change settings |
| `ui:notify` | `context.ui.notify()` — a card in the bottom-right of the window, and `context.ui.onAction()` to hear what the reader did with it |
| `ui:panel` | Contribute a panel — a page of the extension's own, beside the message or as a dialog — and raise your own with `context.ui.openPanel()` |

**What "enforced" means.** A workflow can return any label it likes; returning
one is not the same as being allowed to apply it. Every workflow result passes
through
[`planWorkflowEffects`](../packages/core/src/extensions/workflow-effects.ts),
which drops what the extension did not ask for:

- a label needs `email:label`; `read` and `starred` need `email:flag`;
- `answered`, `draft` and `deleted` are **always refused**. Each means something
  to IMAP, none has a sync path here, and writing one locally would produce a
  message that looks answered — or looks deleted, and vanishes from the list —
  on one machine and nowhere else;
- a refusal is logged once per extension/label/reason and the rest of the
  result still applies.

So an extension installed to read mail cannot quietly acquire the ability to
change it. Ask for the permission you need, and no more: the user sees the list.

---

## The context object

```ts
context.manifest            // your own manifest, parsed
context.storagePath         // a directory that belongs to you

context.registerWorkflow(w) // see below
context.unregisterWorkflow(id)

context.events              // subscribe to pipeline events
context.storage             // get / set / delete / keys / clear  (storage:local)
context.ai                  // categorize / summarize / complete  (ai:use)
context.settings            // get / update / has                 (settings:read|write)
context.mail                // read and change mail on demand     (email:*)
context.ui                  // notify / dismiss / onAction /
                            //   openPanel / openMessage          (ui:notify, ui:panel)
context.log                 // debug / info / warn / error

context.subscriptions       // push an unsubscribe here and it runs on deactivate
context.exports             // the functions your declared capabilities point at
```

`context.ai` is `undefined` without `ai:use`, so check it rather than assuming
it. Everything else is always present and refuses politely without the
permission.

### `context.exports` and capabilities — being callable on demand

Workflows run when mail arrives. For something the user asks for — summarize
*this* thread, now — export a function and point a **capability** at it.

A capability is a job the app might want done, named in your manifest:

```jsonc
"contributes": {
  "capabilities": [
    {
      "id": "thread.summarize",
      "export": "summarizeThread",
      "priority": 10,
      "description": "Summarize a thread with a local model"
    }
  ]
}
```

```ts
context.exports = {
  summarizeThread: async (emails) => ({ summary: '...', key_points: [] }),
};
```

The app never names an extension. It asks for the **job**:

```ts
const invoked = await window.electronAPI.extensions.invoke('thread.summarize', emails);
if (invoked.success && invoked.data?.served) {
  // invoked.data.value is what your export returned
}
```

`served: false` means nothing installed declares that capability — the ordinary
state of a fresh install, and the caller falls back to whatever it would have
done without extensions. If two extensions declare the same capability, the
higher `priority` wins; ties break by extension id, so the answer is the same on
every run rather than depending on activation order. A capability whose `export`
is missing is skipped, and the next provider is asked.

`extensions.capabilities()` lists what is currently served, so a surface can
decide whether to offer a feature at all before invoking it.

### `context.mail` — reading and changing mail on demand

Workflows can only act at the instant a message arrives. `context.mail` acts at
any time, which is what lets an extension respond to something the reader did:

```ts
await context.mail.markRead(emailId);            // email:flag
await context.mail.markUnread(emailId);          // email:flag
await context.mail.star(emailId);                // email:flag
await context.mail.unstar(emailId);              // email:flag
await context.mail.addLabel(emailId, 'receipts');    // email:label
await context.mail.removeLabel(emailId, 'receipts'); // email:label
await context.mail.move(emailId, folderId);      // email:move
await context.mail.trash(emailId);               // email:delete
const email = await context.mail.get(emailId);   // email:read
const folders = await context.mail.folders(accountId); // email:read
```

Every method returns a promise and **rejects** rather than throwing
synchronously, so `context.mail.markRead(id).catch(...)` is enough to handle a
refusal, a message that has since been deleted, and an account that has since
been closed.

Three things hold this together:

- the permission is checked in the main process against the set the user
  approved, and the label changes are checked a second time by the same
  `planWorkflowEffects` a workflow result goes through, so an on-demand change
  and an on-arrival change mean exactly the same thing;
- you name an **id**, never a record — nothing your extension invents about a
  message reaches storage;
- every mutation is logged with your extension id. What an installed extension
  did to someone's mailbox is answerable from the log alone.

`trash` is a move to the account's trash folder, never an expunge. An extension
can put a message in the bin; only the reader empties it.

`get` returns `null` and `folders` returns `[]` for a mailbox this extension
cannot reach, and an unknown id and an id in a closed account fail *identically*
— so an extension cannot use the difference to learn which accounts exist.

### `context.ui.notify` — a card on screen

```ts
context.ui.notify({
  id: `otp-${email.id}`,        // namespaced by extension; same id replaces in place
  title: 'Verification code',
  body: 'from Acme',
  fields: [{ label: 'Code', value: '481920', copyable: true, emphasis: true }],
  expiresAt: Date.now() + 5 * 60_000,  // renders a live countdown
  emailId: email.id,            // adds an "Open the message" button
  accountId: email.accountId,
});
```

Everything is sanitised before it reaches the window: strings are capped,
malformed fields dropped, `expiresAt` clamped, and the id prefixed with your
extension id so two extensions cannot replace or dismiss each other's cards. A
card with no id or no title is dropped entirely. At most three are shown.

### `context.ui.onAction` — what the reader did with your card

A card without this is a dead end: you can show a code but never learn that
anyone took it. `onAction` is the return leg.

```ts
context.ui.onAction(async (action) => {
  if (action.action !== 'copy') return;
  await context.mail.markRead(action.emailId!);
});
```

`action.action` is one of:

| | |
| --- | --- |
| `copy` | a copyable field was copied — `fieldIndex` and `fieldLabel` say which |
| `open` | the reader pressed "Open the message" |
| `dismiss` | the reader closed the card |
| `expire` | the countdown ran out and nobody acted |

`dismiss` and `expire` are deliberately distinct, and neither means the same
thing as `copy`. A code that expired unused is worth re-offering; a message
whose code was never taken must not be marked read, or the reader loses it.

`action.notificationId` is **your** id, not the namespaced one — the host strips
the prefix on the way in, so you never see the namespacing and never have to
write it. A dismissal *you* asked for with `ui.dismiss` is not reported back.

Returns an unsubscribe; push it onto `context.subscriptions` if you register one
outside `activate`. A handler that throws is logged and does not stop the others.

### `context.ui.openPanel` and `openMessage`

```ts
context.ui.openPanel('my-panel');                  // ui:panel
context.ui.openMessage(emailId, accountId);        // email:read
```

`openPanel` is checked against **your own** manifest, so one extension cannot
raise another's panel; the window still decides whether it can honour the
request (a sidebar panel needs a message open). `openMessage` performs the same
navigation a notification click does — switch account, then select — and is
logged with your extension id, because it moves the reader somewhere they did
not ask to go.

---

## Workflows, and the two-stage contract

A workflow is `shouldProcess` plus `process`. `shouldProcess` should be cheap —
it runs for every message — and `process` does the work.

**Bodies are fetched lazily, AFTER the message is stored.** So there are two
passes:

| Stage | When | What the message has |
| --- | --- | --- |
| `arrival` | on `email:synced`, for genuinely new mail | headers, subject, addresses; **no body** |
| `body` | on `email:body-ready` | the body as well |

Every workflow runs at `arrival`. A workflow that sets `"requiresBody": true`
runs at **both** stages — so it sees the same message twice and **must be
idempotent**. Write it so the second pass either recognises its own earlier
work or harmlessly repeats it. `otp-code` keeps a bounded map of the codes it
has already shown for exactly this reason.

Results:

```ts
{
  success: true,
  labelsToAdd: ['vip'],       // the real channel for tags and flags
  labelsToRemove: ['newsletter'],
  skipRemaining: false,       // stop lower-priority workflows for this message
  metadata: { /* yours */ },
}
```

`priority` orders workflows across all extensions, lowest first. A failed
result (`success: false`) is skipped entirely — nothing it asked for is applied.

Work is **serialised**: one message at a time, with a time-budget yield between
them, so a first sync of 40,000 messages cannot start 40,000 concurrent AI
calls on the main process. At most 2,000 messages wait at once; past that the
oldest are dropped, because the newest mail is the mail the user is looking at.
Keep `process` reasonably quick — everything behind it is waiting.

---

## Panels

A panel is an HTML page the extension ships and the app renders. Declare it in
the manifest, ask for `ui:panel`, and it appears beside the open message:

```json
{
  "id": "order-tracker",
  "name": "Order Tracker",
  "version": "1.0.0",
  "description": "Shows the order a shipping mail is about",
  "author": "You",
  "engines": { "sarvinbox": "^1.1.0" },
  "permissions": ["ui:panel", "email:read", "storage:local"],
  "contributes": {
    "panels": [
      {
        "id": "order",
        "title": "Order",
        "entry": "panel.html",
        "surface": "sidebar",
        "icon": "icon.svg",
        "width": 340,
        "autoOpen": false
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Panel id, scoped to your extension. Lowercase, digits, hyphens |
| `title` | Shown in the panel header |
| `entry` | The HTML file, relative to your folder. A path that escapes it is refused at load |
| `surface` | `sidebar` (a column beside the message) or `modal` (a dialog) |
| `icon` | Optional SVG, relative to your folder |
| `width` | Preferred sidebar width in px, clamped to what the window can give |
| `autoOpen` | Sidebar only: open without waiting to be asked |

There is deliberately **no surface that renders inside the message body**. A
panel drawn there would be indistinguishable from the message's own content,
which is exactly the confusion a phishing mail wants. Extension UI stays
outside the body so the reader can always tell the app from the mail.

### No build step

A panel-only extension has no `main` and no background code:

```
order-tracker/
  sarvinbox-extension.json
  panel.html
  panel.js
  icon.svg
```

That is a complete extension — no bundler, no `dist/`, nothing to compile. If
you do want background code, `main` stays optional: with no `main` the loader
looks for `index.js`, `dist/index.js` or `src/index.js` in your folder.

### What a panel can do

The page is served from `sarv-extension://<your-extension-id>/…`, so it gets
**its own origin**. Same-origin policy is what keeps one extension's panel out
of another's storage and out of the app's. It is loaded into a sandboxed iframe
under `default-src 'none'` with no `connect-src`: no Node, no app internals, no
network. A panel cannot send the message it was shown anywhere.

Everything it can do, it asks for. Load the bundled SDK — it is served by the
app, so there is nothing to install or vendor:

```html
<script src="sarv-extension://sdk/sarv.js"></script>
```

```js
const message = await sarv.getCurrentMessage();   // needs email:read; null if none open
await sarv.storage.set('seen', message.id);       // needs storage:local
const keys = await sarv.storage.keys();
const pref = await sarv.settings.get('apiKey');   // needs settings:read
const all  = await sarv.settings.all();
await sarv.notify({ id: 'done', title: 'Tracked' }); // needs ui:notify
const parsed = await sarv.call('parseOrder', message.body); // your own module's export
sarv.close();
sarv.resize(420);

const stop = sarv.on('message-changed', () => render());  // stop() to unsubscribe
```

Every one of those is re-checked in the main process against the permissions
the user actually granted — the renderer relays, it does not decide. A call
whose permission you did not declare is refused, and `ui:panel` itself is
checked first: a panel is never a way around a permission the extension was
refused. An unknown method is refused too, so a request the host does not
recognise fails closed rather than falling through.

**The panel never names its own message.** `getCurrentMessage()` returns
whatever the reader has open — the app decides which message that is, reads the
row, and hands back a reduced view (ids, addresses, subject, date, labels,
flags, body). A panel cannot ask for a message by id.

`sarv.call(name, ...args)` reaches the functions your background module put on
`context.exports`, which is how a panel and its extension share work instead of
implementing it twice. It needs no extra permission: the code on both ends is
yours.

---

## The SDK

Extensions build against [`@sarvinbox/extension-sdk`](../packages/extension-sdk),
a small published package — not against `@sarvinbox/core`, which is private to
this repository. It is a thin re-export of core's two SDK entry points with
every type and helper inlined at build time, so an extension author needs
nothing from here:

```bash
npm install --save-dev @sarvinbox/extension-sdk
```

```ts
import { hasTag, addTag, isSentFolder, createLoopYielder } from '@sarvinbox/extension-sdk';
import type { EmailForSummary, ExtensionContext } from '@sarvinbox/extension-sdk';
```

Inside this repository the same code lives at `@sarvinbox/core/extension-sdk`;
the published package is what the outside world compiles against.

It carries the tag encoding (`EmailRecord.tags` is a `|a|b|c|` string, not an
array — reading it by hand is how tag corruption gets introduced), folder
classification, cooperative yielding, a flush scheduler, and single-flight
coalescing. Reuse them; a second implementation of the sent-folder rules will
drift and be wrong in ways nobody notices.

**Why there is a second entry point.** An extension is one self-contained file,
and esbuild cannot tree-shake a CommonJS dependency: anything the SDK barrel
touches is charged to *every* extension that imports it. So helpers with such a
dependency live behind their own path, and importing it is how you opt into the
weight:

```ts
import { htmlToPlainText, stripQuotedTail } from '@sarvinbox/extension-sdk/text';
```

(Inside this repository that path is spelled flat —
`@sarvinbox/core/extension-sdk-text` — because Vite 5 fails to resolve a deep
export subpath under a key that is itself an export, while Node resolves it
fine; the tests would have failed where the built extension worked. The
published package exposes the nested spelling, which has no such problem.)

For scale: `otp-code` and `vip-scoring` build to under 15 KB each.
`email-summarization`, which pulls in the text helpers, is about 310 KB. If a
build suddenly jumps, something heavy came in through an import.

---

## Testing

Each extension is its own package with its own `vitest`. Keep the decisions in
pure modules and the entry point as wiring, which is how all three published
ones are laid out — `otp-detect.ts` answers "is there a code in this text?",
`index.ts` only plumbs it. Then the tests need no host at all:

```bash
pnpm --filter my-extension test
pnpm --filter my-extension build
```

The project rule applies to extensions too: tests ship in the same change, and
each one carries a one-line comment naming the regression it protects against.
See [TESTING.md](TESTING.md).

---

## Publishing and installing

Extensions are distributed as checksum-pinned release archives, indexed by a
registry the app fetches over HTTPS. The full publishing walkthrough —
scaffolding, the release tag format, CI, and how to run a registry of your own
— is in the
[SarvInbox-extensions README](https://github.com/Sarv/SarvInbox-extensions#readme).
What the app does with what it finds there:

1. **Fetch.** `apps/desktop/extensions.config.json` lists the registries this
   build reads. What it fetches is a *thin index*: one small document carrying
   only what the Browse list draws. Only `https://` on GitHub hosts is
   accepted, the official registry is always consulted first, and it is parsed
   by
   `packages/core/src/extensions/marketplace.ts` — total, fail-closed on
   anything security-relevant. A malformed entry is dropped; one bad entry
   never takes down the panel. The result is cached on disk and the cache is
   used when the network is unavailable, so an offline user keeps the list.
2. **Resolve.** Clicking Install fetches that one extension's detail document
   — the download URL and the pinned SHA-256, which the index does not carry.
   Its id and version are checked against the entry the list showed: a detail
   document that has drifted is refused rather than installed, because the
   user is about to approve permissions for the version they were shown. A
   registry that still publishes the old flat format needs no such request and
   keeps working unchanged.
3. **Prompt.** The user sees the extension's permissions in plain language,
   riskiest first, alongside the SHA-256 the registry pinned. Nothing is
   downloaded until they confirm.
4. **Verify.** The archive is downloaded with a hard size cap, hashed, and
   compared against that digest. A mismatch aborts before a single byte is
   unpacked.
5. **Unpack.** Only `sarvinbox-extension.json`, `dist/*.js`, `icon.svg`,
   `README.md` and `LICENSE` are extracted; anything else in the archive is
   ignored.
6. **Re-check.** The manifest inside the archive must declare the same id,
   version and permission set the user was shown. The registry is only an
   index — the manifest is what the host actually loads, so a disagreement
   means the user approved something else, and the install is refused.
7. **Install.** The folder goes to the extension manager, which validates the
   manifest, checks `engines.sarvinbox` against the running version, copies it
   into the app's extensions directory and activates it.

The permission list the renderer displayed is sent back to the main process on
confirm and compared against the registry again. That is what makes the prompt
a gate rather than decoration, and it catches a registry that changed between
the dialog opening and Install being clicked.

### Extensions this build starts with

`apps/desktop/extensions.config.json` names them:

```json
{
  "registries": ["https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json"],
  "systemExtensions": ["otp-code", "vip-scoring"]
}
```

`systemExtensions` are installed and enabled the first time a profile opens.
There is no prompt for these — the choice was made when the app was built, and
their permissions are listed in the panel like any other. They can be disabled
or uninstalled afterwards, and the app does not reinstate one the user removed.

`apps/desktop/scripts/prefetch-default-extensions.mjs` downloads and verifies
them at build time into `build/default-extensions/`, which electron-builder
copies into Resources. First run therefore needs no network; the registry is
only consulted for an extension the build could not seed.

### Installing one you are writing

**Settings -> Extensions -> Install from folder** takes any directory
containing a `sarvinbox-extension.json` and its built `dist/`. That is the
loop to use while developing — no registry, no release, no checksum.

Because an extension runs in the main process with the permissions it declared,
tell people what yours does and why it needs each one — the README in each of
the three published extensions is the pattern to follow.
