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

## Licence

MIT
