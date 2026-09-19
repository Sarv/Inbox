# Third-party notices

Sarv Inbox is licensed under the [Sarv Community License](./LICENSE). The
components listed here are **not**: each is supplied by its own authors under
its own licence, and those licences are unaffected by ours. Nothing in the Sarv
Community License adds restrictions to them, and nothing here grants you rights
in Sarv Inbox itself beyond the LICENSE file.

This lists the direct runtime dependencies that ship inside the application.
Build- and test-only tooling is excluded. For the complete transitive set with
exact versions, see `pnpm-lock.yaml`, or generate a full report:

```bash
pnpm licenses list --prod
```

## Obligations worth knowing

- **MPL-2.0 components** (`ical.js`) are file-level copyleft. Using them
  unchanged imposes nothing on Sarv Inbox. If you *modify* one of their files,
  that file stays MPL-2.0 and you must publish your changes to it.
- **`dompurify`** is offered under MPL-2.0 **or** Apache-2.0. Sarv Inbox takes it
  under **Apache-2.0**, so no copyleft obligation attaches.
- **Apache-2.0 components** require their NOTICE text to travel with binary
  distributions.
- **Electron and Chromium** carry their own extensive notices, generated into the
  packaged application by electron-builder — see the `LICENSES.chromium.html`
  file inside a built app bundle.

A full copy of each licence text is in the corresponding package's directory
under `node_modules/` after `pnpm install`.

## Direct runtime dependencies

### (MPL-2.0 OR Apache-2.0)

- **dompurify** 3.4.12 — DOMPurify is a DOM-only, super-fast, uber-tolerant XSS sanitizer for H  
  https://github.com/cure53/DOMPurify

### ISC

- **lru-cache** 10.4.3 — A cache object that deletes the least-recently-used items.  
  https://github.com/isaacs/node-lru-cache
- **lucide-react** 0.309.0 — A Lucide icon library package for React applications  
  https://github.com/lucide-icons/lucide

### MIT

- **@op-engineering/op-sqlite** 7.4.3 — Next generation SQLite for React Native  
  https://github.com/OP-Engineering/op-sqlite
- **@sentry/electron** 7.15.0 — Official Sentry SDK for Electron  
  https://github.com/getsentry/sentry-electron
- **@tiptap/extension-color** 3.15.1 — text color extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/extension-image** 3.15.1 — image extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/extension-link** 3.15.1 — link extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/extension-placeholder** 3.15.1 — placeholder extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/extension-text-align** 3.15.1 — text align extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/extension-text-style** 3.15.1 — text style extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/extension-underline** 3.15.1 — underline extension for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/pm** 3.15.1 — prosemirror wrapper package for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/react** 3.15.1 — React components for tiptap  
  https://github.com/ueberdosis/tiptap
- **@tiptap/starter-kit** 3.15.1 — starter kit for tiptap  
  https://github.com/ueberdosis/tiptap
- **better-sqlite3** 12.11.1 — better-sqlite3 with multiple-cipher encryption support  
  https://github.com/m4heshd/better-sqlite3-multiple-ciphers
- **chardet** 2.2.0 — Character encoding detector  
  https://github.com/runk/node-chardet
- **chrono-node** 2.10.0 — A natural language date parser in Javascript  
  https://github.com/wanasit/chrono
- **date-fns** 3.6.0 — Modern JavaScript date utility library  
  https://github.com/date-fns/date-fns
- **email-addresses** 5.0.0 — An email address parser based on rfc5322  
  https://github.com/jackbearheart/email-addresses
- **email-reply-parser** 2.3.9 — Node library for parsing plain text email content. Based on https://gi  
  https://github.com/crisp-oss/email-reply-parser
- **free-email-domains** 1.12.1 — A list of free email domains  
  https://github.com/Kikobeats/free-email-domains
- **html-to-text** 10.0.0 — Advanced html to plain text converter  
  https://github.com/html-to-text/node-html-to-text
- **iconv-lite** 0.7.2 — Convert character encodings in pure javascript.  
  https://github.com/pillarjs/iconv-lite
- **imapflow** 1.4.2 — IMAP Client for Node  
  https://github.com/postalsys/imapflow
- **ipaddr.js** 2.5.0 — A library for manipulating IPv4 and IPv6 addresses in JavaScript.  
  https://github.com/whitequark/ipaddr.js
- **libmime** 5.3.8 — Encode and decode quoted printable and base64 strings  
  https://github.com/nodemailer/libmime
- **libphonenumber-js** 1.13.8 — A simpler (and smaller) rewrite of Google Android's libphonenumber lib  
  https://gitlab.com/catamphetamine/libphonenumber-js
- **mailparser** 3.9.1 — Parse e-mails  
  https://github.com/nodemailer/mailparser
- **markdown-it** 14.3.0 — Markdown-it - modern pluggable markdown parser.  
  markdown-it/markdown-it
- **p-limit** 3.1.0 — Run multiple promise-returning & async functions with limited concurre  
  sindresorhus/p-limit
- **p-map** 4.0.0 — Map over promises concurrently  
  sindresorhus/p-map
- **p-retry** 4.6.2 — Retry a promise-returning or async function  
  sindresorhus/p-retry
- **pino** 10.3.1 — super fast, all natural json logger  
  https://github.com/pinojs/pino
- **pretty-bytes** 7.1.0 — Convert bytes to a human readable string: 1337 → 1.34 kB  
  sindresorhus/pretty-bytes
- **react** 18.3.1 — React is a JavaScript library for building user interfaces.  
  https://github.com/facebook/react
- **react-dom** 18.3.1 — React package for working with the DOM.  
  https://github.com/facebook/react
- **sanitize-html** 2.17.6 — Clean up user-submitted HTML, preserving allowlisted elements and allo  
  https://github.com/apostrophecms/apostrophe
- **tldts** 7.4.10 — Library to work against complex domain names, subdomains and URIs.  
  ssh://git@github.com/remusao/tldts
- **turndown** 7.2.2 — A library that converts HTML to Markdown  
  https://github.com/mixmark-io/turndown
- **uniqolor** 1.1.1 — Generate unique and beautiful colors from any texts or numbers  
  https://github.com/dastoori/uniqolor
- **zod** 3.25.76 — TypeScript-first schema declaration and validation library with static  
  https://github.com/colinhacks/zod
- **zustand** 4.5.7 — 🐻 Bear necessities for state management in React  
  https://github.com/pmndrs/zustand

### MIT-0

- **nodemailer** 7.0.12 — Easy as cake e-mail sending from your Node.js applications  
  https://github.com/nodemailer/nodemailer

### MPL-2.0

- **ical.js** 2.2.1 — Javascript parser for ics (rfc5545) and vcard (rfc6350) data  
  https://github.com/kewisch/ical.js

### WTFPL OR ISC

- **sanitize-filename** 1.6.4 — Sanitize a string for use as a filename  
  git@github.com:parshap/node-sanitize-filename

---

If you believe a component is listed incorrectly, or a notice is missing, please
open an issue or write to [legal@sarv.com](mailto:legal@sarv.com).
