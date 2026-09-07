// Renderer-local email validation. Mirrors packages/core/src/utils/validators.ts
// — kept as a separate copy because the renderer MUST NOT import a runtime value
// from `@sarvinbox/core`: that barrel transitively pulls Node-only modules
// (imapflow / mailparser / nodemailer → `require('stream')`) into the browser
// bundle, which throws "Dynamic require of 'stream' is not supported" at load and
// blanks the renderer. Uses only `zod`, an existing renderer dependency — the same
// validator core uses, so the two stay behaviourally identical. Keep in sync with
// core (see the twin note in ./email-address.ts).

import { z } from 'zod';

const emailAddressSchema = z.string().email();

/** Validate an email address (identical semantics to `@sarvinbox/core` isValidEmail). */
export function isValidEmail(email: string): boolean {
  return emailAddressSchema.safeParse(email).success;
}
