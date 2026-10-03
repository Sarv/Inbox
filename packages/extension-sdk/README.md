# @sarvinbox/extension-sdk

Types and helpers for building [Sarv Inbox](https://github.com/Sarv/Inbox) extensions.

```bash
npm install --save-dev @sarvinbox/extension-sdk
```

```ts
import type { ExtensionContext, EmailRecord } from '@sarvinbox/extension-sdk';
import { hasTag, addTag, createLoopYielder } from '@sarvinbox/extension-sdk';

export function activate(context: ExtensionContext) {
  context.registerWorkflow({
    id: 'my-workflow',
    requiresBody: false,
    execute: async (email: EmailRecord) => {
      if (hasTag(email.tags, 'important')) return { success: true };
      return { success: true, tags: addTag(email.tags, 'seen-by-my-extension') };
    },
  });
}
```

Two entry points:

| Import | Contents | Cost |
| --- | --- | --- |
| `@sarvinbox/extension-sdk` | The `ExtensionContext` contract, tag encoding, folder classification, cooperative yielding, flush scheduling, single-flight | Pure, dependency-free, a few KB |
| `@sarvinbox/extension-sdk/text` | `htmlToPlainText`, `stripQuotedTail` | Pulls `html-to-text` — roughly +107 KB into your bundle |

They are separate because an extension is loaded by path with `require()` from a
folder that has no `node_modules` beside it, so it ships as one bundled
CommonJS file and pays for everything it imports. Those two text helpers carry
CommonJS dependencies, which no bundler can tree-shake back out — importing the
second entry point is how you say you want that weight.

Full guide, including how to publish an extension so it appears in the app's
Browse tab: **https://github.com/Sarv/SarvInbox-extensions**

## Antivirus scanning

`context.security` and the panel SDK's `sarv.security` offer the same six methods:

| Method | Result |
| --- | --- |
| `getTargets()` | `AntivirusScanTarget[]` for the message open in the app |
| `getSetup()` | Public `AntivirusSetupStatus`, including enabled accounts and consent versions |
| `openSetup()` | Opens the app's trusted scanner setup dialog |
| `submit(targetIds, options?)` | Starts a scan and returns `AntivirusScanJob` |
| `get(jobId)` | Returns current progress and results for this extension's job |
| `cancel(jobId)` | Cancels this extension's job and returns its final state |

All methods return promises and require `security:scan-attachments`. Panels also
require `ui:panel`. The host issues opaque target IDs; extensions submit those
IDs without receiving attachment bytes or choosing a message, account, endpoint,
or credential. An unavailable target carries `unavailableReason` and cannot be
submitted. Setup credentials are stored by the app and never returned by the SDK.

Email body targets additionally require `security:scan-body`, body sharing enabled
in setup, and explicit consent on each submission:

```ts
const targets = await context.security.getTargets();
const attachment = targets.find(target => target.kind === 'attachment' && !target.unavailableReason);
if (attachment) {
  const job = await context.security.submit([attachment.targetId]);
  const progress = await context.security.get(job.id);
}

// Call only after the reader explicitly chooses to share this message's body.
const body = targets.find(target => target.kind === 'email-body' && !target.unavailableReason);
if (body) {
  await context.security.submit([body.targetId], { includeBodyConsent: true });
}
```

Scan results distinguish `no-threat-detected`, `threat-detected`, `incomplete`,
and `error`. An incomplete scan does not establish that a file is safe. A job
can also expire or be cancelled. Disabling or uninstalling an extension revokes
its scanner consent and cancels pending work.

Result items may include the validated engine version, definition version and
update timestamp, completion time, exact byte count and SHA-256 fingerprint.

## Licence

MIT
