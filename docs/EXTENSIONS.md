# Writing a Sarv Inbox extension

An extension is a folder with a manifest and, usually, one CommonJS file. Sarv
Inbox runs that file in a **sandbox of its own**, hands it a context object, and
lets it act on mail as it arrives — tag it, star it, ask the AI about it, or put a
card on screen. An extension that crashes or loops takes down nothing but itself.

The file runs in a Web Worker, not in Node. It has no `require('fs')`, no `process`
and no network of its own: it cannot read the user's files or send anything
anywhere unless the app does it on its behalf, and the app does so only under the
permissions the user approved. See [Trust model](#trust-model), and
[Coming from the Node runtime](#coming-from-the-node-runtime) if your extension
was written before this.

An extension can also contribute a **panel**: a page of its own, shown beside
the open message or as a dialog. A panel needs no build step and no background
code at all — an `index.html` in a folder is a complete extension. See
[Panels](#panels).

Published extensions are distributed through
[Sarv/SarvInbox-extensions](https://github.com/Sarv/SarvInbox-extensions),
which serves a registry index, and the app installs them from there —
including the ones it ships with. That repository's README is the full
author-and-publish guide; this document is the host side of the contract: what
the app gives an extension, what it will and will not let one do, and how an
install is verified.

The ClamAV extension is maintained in this Inbox repository at
`extensions/clamav-scan`, alongside its desktop host and SDK integration.
Install that folder locally to use the scan API. Its scanning server is
maintained separately in `Inbox-av-server`; registry publication does not move
the extension source out of Inbox. See
[ClamAV Scan](antivirus/README.md) for setup, consent and verification.

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
  icon.svg                   # optional - your logo in the catalogue
  screenshot-*.svg           # optional - pictures of it running
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
  "icon": "icon.svg",
  "category": "productivity",
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

**Say what it looks like.** The Browse tab, the install prompt and the installed
list all show a "what it does, and where you will see it" section. It is derived
from `contributes` and `permissions`, not written by you: declare a sidebar
panel and the reader is told a panel appears beside their mail; ask for
`email:label` and they are told, in those words, that it can add and remove
labels. Nothing there can overstate what the app will actually let the extension
do — which is the point — so the way to make an extension legible is to declare
what it really contributes.

Add pictures of it in use with the optional `screenshots` array:

```json
"screenshots": [
  { "url": "./screenshots/sidebar.png", "caption": "A passcode in the sidebar" }
]
```

Each `url` is a path inside your extension folder (absolute URLs are allowed but
must be on the same hosts the registry itself is served from — an image
elsewhere is silently not shown, because the catalogue loads it simply by being
drawn). `caption` doubles as the image's alt text. At most six are shown.

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

**3. Build it to one file.** The sandbox loads `main` with a small CommonJS loader
of its own, which finds your other files by relative path and nothing else: there
is no `node_modules` lookup and no Node module to require, so the entry point must
carry everything it needs:

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
  platform: 'browser', // your dependencies get their browser builds, with no Node in them
});
```

**4. Install it.** Settings -> Extensions -> **Install Extension**, and pick the folder. The
app validates the manifest, copies the folder into its own extensions
directory, and activates it. From then on the copy is what runs — reinstall
after a rebuild while you are developing.

---

## How your extension looks in the catalogue

Four optional manifest fields are what a reader sees *before* they agree to run
your code. Everything else in the manifest describes the extension to the app;
these describe it to a person.

```json
{
  "icon": "icon.svg",
  "category": "security",
  "keywords": ["otp", "2fa", "verification"],
  "screenshots": [
    { "url": "screenshot-card.svg", "caption": "The code appears in the corner the moment the mail lands" },
    { "url": "screenshot-copy.svg", "caption": "Copying it marks that message read" }
  ]
}
```

**`icon`** — a path inside your extension folder. It is drawn in an `<img>`, so
it is rendered in isolation: a `currentColor` stroke has nothing to inherit from
and comes out black, which disappears against a dark theme. Give the file its
own literal colours, and check it at 32px — the browse list is the size that
matters, not the detail page. SVG and PNG both work. This one also ships inside
the archive, so an installed extension still has an icon with no network.

**`category`** — one shelf, used to group the browse list. The app folds
whatever you write onto its own list: `productivity`, `security`,
`organisation`, `communication`, `office`, `ai`, `tools`, `other`. Common
synonyms are folded too (`organization`, `tool`, `privacy`, `automation`,
`llm`...); anything it does not recognise becomes `other`. The field grants
nothing and restricts nothing — it is purely where you sit in the list.

**`screenshots`** — pictures of it running, shown on the extension's page.
Answer the question a reader actually has: *what will I see, and where?* A shot
of the card, panel or tag in its real place in the window beats a diagram of how
it works. `caption` is optional and worth writing. These are **not** shipped in
the archive; the catalogue reads them over https, so they cost an installed
reader nothing.

Both `icon` and `screenshots` are paths relative to your extension folder. The
registry expands them to absolute URLs on a host the app is willing to load
from — the catalogue draws them for extensions nobody has installed yet, so an
arbitrary host would be a request made on the reader's behalf. An absolute URL
you write yourself is passed through and must be on that allowlist, so a path is
almost always the right answer.

One caveat worth knowing: the registry describes the **released archive**, not
your working tree. New `category` and `screenshots` values reach the catalogue
when you cut the release that contains them. Image *files* are read from the
repository, so re-drawing an icon takes effect without a release — renaming one
does not.

---

## Permissions

Declared in the manifest, shown to the user before install, and enforced in the
main process at the point of effect — not in the extension's own sandbox, which
only makes an authoring mistake fail where it was written.

Because the code has nothing else to reach, these are the whole of what an extension
can do: `context.mail`, `context.ai`, `context.storage`, `context.network`, settings,
the UI calls and what a workflow result may change (see [Trust model](#trust-model)).

| Permission | Grants |
| --- | --- |
| `email:read` | Read subject, body and headers — the message being processed, and any message by id through `context.mail` |
| `email:label` | Add and remove labels/tags, on arrival or on demand |
| `email:flag` | Change `read` and `starred` |
| `email:move` | Move messages between folders |
| `email:delete` | Move messages to the trash folder — never an expunge |
| `ai:use` | `context.ai` — categorize, summarize, and raw completions |
| `storage:local` | `context.storage` — a private JSON store under the app's data directory |
| `network:fetch` | `context.network.fetch` — the extension's only way to the internet. `https` to public addresses on the default port. Nothing else in the sandbox can reach the network, with or without this |
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

So an extension installed to read mail cannot quietly use the app to change
it. Ask for the permission you need, and no more: the user sees the list.

### Trust model

Be precise about what the host does and does not protect, both when writing an
extension and when telling people what yours does:

- **Extension code is confined.** Each extension's module runs in a Web Worker of
  its own hidden renderer, `sandbox: true`, in an in-memory session of its own. It
  has no `require` of anything but its own files, no `process`, no Node module, and
  no way to read a file: `fetch('file://…')`, XHR, `import()`, `importScripts` and a
  nested Worker are all refused.
- **It has no network of its own.** Inside the sandbox `fetch`, `XMLHttpRequest`,
  `WebSocket`, `WebTransport`, `EventSource`, fonts and `importScripts` of a URL are
  blocked by a Content-Security-Policy of `connect-src 'none'` and, except for
  WebTransport, again by a `webRequest` filter in the main process. The one way out
  is `context.network.fetch`, which main refuses without `network:fetch`.
- **Permissions are the whole of what it can do, and they mean what they say.** An
  extension granted `email:read` and `network:fetch` *can* send a user's mail
  anywhere: the sandbox limits what it can reach, not what it does with what it was
  given. Asking for both is what deserves a reader's attention, and the install prompt
  says so.
- **One extension cannot reach another.** Each has its own renderer process, its own
  origin storage and its own message port. Main reads a message's sender from the
  port, never from the message, so posting in another extension's name is refused.
- **A hung or crashing extension is stopped, and only that one.** A Worker that does
  not answer for 30 seconds is killed: do not block for that long. So is one that goes
  past a [limit](#what-an-extension-may-ask-of-the-app). Those two stay off until
  something asks for them again (turning it off and on, or the next launch), and the
  user is told why, on a card and in Settings. A renderer that crashes, or runs out of
  memory, is restarted for you, after 2, 15 and then 60 seconds; the user hears about
  it if the third fails. Ten quiet minutes forgive past crashes. Your panel keeps
  working throughout, and so does anything the app does for you rather than your code,
  such as attachment scanning.
- **An extension that takes the whole app down is held back.** That should not be
  possible, and this is the backstop in case it is: extensions start before the window,
  so a crash there happens on every launch and leaves nowhere to turn it off. If the
  app dies while starting extensions, or within a minute of it, on two launches in a
  row, the next launch starts with no extension code running and a card naming what was
  held back. **Settings, Extensions** has the button to turn them back on, and they
  stay held until it is pressed or the app is updated. Their data, settings and
  approvals are not touched, and panels keep working. Quitting, restarting for an
  update and shutting the machine down do not count, however quickly. Killing the app
  by force, twice, in its first minute does, because it cannot be told from a crash.
- **The operating system sandbox is required.** A release build refuses to run
  extension code in a renderer that the OS has not sandboxed: it checks the running
  process rather than trusting the setting (`app.getAppMetrics()` on macOS and
  Windows, seccomp in `/proc/<pid>/status` on Linux). Without it, one Chromium bug
  would hand an extension everything the user's account can touch. On a Linux with
  no working sandbox, Chromium itself refuses to start the app unless it is launched
  with `--no-sandbox`; launched that way, the app works and its extensions stay off,
  with a card and a line in Settings saying why. The `.deb` and `.rpm` set up what the
  sandbox needs. An AppImage needs unprivileged user namespaces, which Ubuntu 24.04
  and later restrict by default: where it cannot have them, the AppImage launches itself
  with `--no-sandbox`, so the card there says to install the `.deb` or `.rpm`.
  Panel-only extensions run no code here and are unaffected. A dev run
  (`pnpm dev:desktop` passes `--no-sandbox`) runs extensions anyway, with a warning in
  the log, confined by the session and policy alone.
- **What it does not stop.** Extension code still has Chromium's attack surface. The
  policy that stops WebTransport is enforced inside the renderer, so a renderer
  exploit could send QUIC packets, though the OS sandbox still keeps it from the disk.
  An extension can burn CPU as long as it keeps answering, and every message it sends
  costs the main process something; the limits above bound that, they do not remove it.
- **Some browser APIs are not there at all.** `navigator.storage.getDirectory` and the
  other File System APIs, `navigator.gpu`, `navigator.serial` and
  `navigator.storageBuckets` are removed before your code runs. The first filled the
  app's own memory, since a sandbox's storage lives there, and the rest are a line to a
  process an extension has no need of. IndexedDB and the Cache API are there, and are
  emptied when your sandbox closes: what must last belongs in `context.storage`.
- **Panels are confined separately.** A panel page is served with a strict
  Content-Security-Policy and framed in a sandboxed iframe, so it cannot reach the
  network or Node on its own (see [Panels](#panels)).
- **Registry downloads are checked against a checksum, not a signature.** The
  archive must hash to the SHA-256 the registry publishes, and the manifest
  inside must match what the user approved. That proves the bytes are the ones
  the registry listed; it does not prove who wrote them. There is no publisher
  signature yet.
- **The user is told.** Both the registry install prompt and **Install from
  folder** say that an extension runs in a sandbox, what it can do through the
  permissions it asks for, and to install only extensions they trust with those.

### What an extension may ask of the app

Every message your code sends costs the app's main process, so there are limits. They
are far past anything a working extension reaches. Going past one of the first group
stops your extension, with a card saying why, because a throttled flood still holds the
main thread. Going past one of the second is refused with an error your code can catch.

| Stops your extension | Limit |
| --- | --- |
| One message to the app, of any kind | 64 MB |
| All messages together, replies included | 512 MB per 5 seconds |
| Messages the app did not ask for | 10,000 per 5 seconds, plus 16 for each call it made to you, so draining a backlog never counts against you |
| Console output | 5,000 lines or 16 MB per 5 seconds |
| Requests for your own files | 2,000 per 5 seconds |
| Workflows | 64 at once, 1,024 registrations in a run |
| Event subscriptions | 64 at once |
| Functions in `context.exports` | 256 |
| A workflow, event or export id | 128 characters, with a description of 1,000 |

| Refused with an error | Limit |
| --- | --- |
| `context.storage`, one value | 5 MB |
| `context.storage`, everything together | 25 MB. Data already over this stays readable and is never deleted; only writes that would grow it are refused |
| `context.storage`, one key | 1,024 characters |
| `context.settings`, one value | 64 KB, under a key of 256 characters |
| `context.settings`, how many | 256 |
| `context.mail`, labels in one change | 32, of 128 characters each |
| Your own files | Each is served once to a sandbox, with no query string, up to 64 MB in all |

A panel has the same 64 MB limit on a request, and is refused rather than stopped.

### Coming from the Node runtime

Extensions used to run as full Node in a shared process. If yours used anything
Node provides, it stops working until you update it. The user sees a card and a line in
Settings naming what it used, for everything in the table below, whether it happens
while starting or later on. There are two things a card cannot cover. An error your own
code catches stays yours, on purpose, so that optional dependencies inside a `try` keep
working: a network request or remote script is the exception, because the app sees those
refused whatever your code does with the error. And an error with nothing to recognize
in it, such as a missing file of your own, is reported as a failure to start if it
happens while starting, and otherwise only in the log.

Their approvals and the data in `context.storage` are kept, so a fixed version picks up
where it left off.

| You used | Use instead |
| --- | --- |
| `require('fs')`, a file under `context.storagePath` | `context.storage` (needs `storage:local`). `storagePath` is now only a name, not a directory. Files already written there stay on disk, but the extension can no longer read them, so move what matters while your users are on the old version |
| `fetch`, `https`, `net`, a WebSocket | `context.network.fetch` (needs `network:fetch`). `https` on the default port, public addresses only. A local server such as `localhost:11434` is out of reach |
| `crypto.createHash` | `crypto.subtle.digest` (async), or a small hash bundled into your code |
| `Buffer` | `Uint8Array`, `TextEncoder`, `TextDecoder`, `atob` |
| `process.env`, `process.platform` | Nothing: settings are what configure an extension, and `navigator.platform` is there if you must |
| `child_process`, native addons | No replacement: there is nothing to run them with |
| `setImmediate` | `setTimeout(fn, 0)` |
| `setTimeout(...).unref()` | Just `setTimeout`: a timer here returns a number, and there is no process for it to keep alive |
| `eval`, `new Function` | Nothing: the policy forbids building a script from a string, which also rules out libraries that compile templates at run time |

A `require` of a Node module throws, naming the module, so optional dependencies
inside a `try` keep working. A `require` of your own files works as it does in Node,
including a folder (`require('..')`, `require('./lib')`), which finds that folder's
`package.json` `main` and then its `index.js`. `tsup`'s `platform: 'browser'` is the quickest route: it
makes bundled dependencies use their browser builds and tells you about whatever
still needs Node.

---

## The context object

```ts
context.manifest            // your own manifest, parsed
context.storagePath         // only a name now; there is no filesystem to use it with

context.registerWorkflow(w) // see below
context.unregisterWorkflow(id)

context.events              // subscribe to pipeline events      (email:read)
context.storage             // get / set / delete / keys / clear  (storage:local)
context.ai                  // categorize / summarize / complete  (ai:use)
context.settings            // get / update / has                 (settings:read|write)
context.mail                // read and change mail on demand     (email:*)
context.network             // fetch over the internet            (network:fetch)
context.ui                  // notify / dismiss / onAction /
                            //   openPanel / openMessage          (ui:notify, ui:panel)
context.log                 // debug / info / warn / error

context.subscriptions       // push an unsubscribe here and it runs on deactivate
context.exports             // the functions your declared capabilities point at
```

`context.ai` is `undefined` without `ai:use`, so check it rather than assuming
it. Everything else is always present and refuses politely without the
permission.

`context.events` needs `email:read` to subscribe to anything, because the bus says
what is happening in the mailbox and `email:synced` carries the whole message.
Extensions listen and cannot emit: the app acts on these events, and must not be able
to be told about mail that never arrived.

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

### `context.network` — the only way to the network

```ts
const response = await context.network.fetch('https://api.example.com/v1/lookup', {
  method: 'POST',                               // GET by default
  headers: { Authorization: `Bearer ${key}` },
  body: JSON.stringify({ q: email.subject }),   // a string or a Uint8Array
  timeoutMs: 10_000,                            // for the answer, and again for the body
});

if (response.ok) {
  const data = response.json<Lookup>();         // also text() and bytes(); not promises:
}                                               // the whole body has already arrived
```

It rejects without `network:fetch`, on a real network failure, and for a destination
the host refuses: anything but `https` on the default port, and any name or address
that is not public, checked where the connection is made so a name cannot rebind to
the reader's router. It follows up to 5 redirects, each held to the same rules, and an
`Authorization` or `Cookie` header does not follow a redirect to another site. A
request and a response may each be up to 10 MB, a call waits at most 2 minutes, and
an extension may have 16 in flight. An answer of any status resolves, as with `fetch`.

There is no cookie jar and nothing of the app's sessions goes with a request, so a site
the user is signed in to sees a stranger.

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

Alongside `emailId`, an action carries two account ids, and the difference
matters as soon as anyone runs more than one mailbox. `action.accountId` is the
account the card was raised from. `action.activeAccountId` is the account the
reader is looking at *right now*, and is absent in a unified view where no
single mailbox is selected.

They diverge whenever one message was delivered to two accounts. That is one
message to the reader, so you will usually draw one card for it — and when they
act on that card, the copy worth touching is the one in the mailbox on screen.
Keep an index from your card id to every `{ emailId, accountId }` it stands for,
and resolve in that order: the target matching `activeAccountId`, else the one
matching `accountId`, else the first you recorded.

```ts
const target = resolveTarget(cards, action);
if (target) await context.mail.markRead(target.emailId);
```

`markRead` takes an email id and nothing else — ids are unique across accounts,
so picking the right `emailId` *is* how you pick the account.

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
   unpacked. The digest comes from the same registry as the download URL, so
   this proves the archive is the one the registry published, not who built
   it — there is no publisher signature yet.
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
loop to use while developing — no registry, no release, no checksum. The app
first shows the same trust notice as the registry prompt and installs nothing
until it is confirmed; the extension then gets every permission its manifest
lists, and is switched on.

Because what an extension can do is what its permissions allow, tell people what
yours does and why it needs each one — the README in each of the three published
extensions is the pattern to follow.
