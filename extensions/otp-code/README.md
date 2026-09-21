# One-Time Passcodes

A Sarv Inbox extension that spots verification codes as they arrive and shows
them on a card with a copy button and a live countdown, so you never open the
email to read six digits.

It also tags those emails `otp`, which is what makes "where was that code from
last Tuesday" answerable afterwards.

## What it does

| | |
| --- | --- |
| Runs on | Every message, twice: on arrival (subject only) and again once the body is downloaded |
| Shows | A notification card: sender, the code, a copy button, and a countdown to expiry |
| Tags | `otp` on any message a code was found in |
| Needs | `email:read`, `email:label`, `storage:local`, `settings:read`, `ui:notify` |
| Needs no | Network access and no AI — detection is local, offline and free |

The countdown uses the validity the email itself states ("this code expires in
10 minutes") when it says one, and falls back to 10 minutes when it does not.

Cards are only shown for mail that arrived in the last 15 minutes. Syncing an
old mailbox tags the codes it finds but does not interrupt you with them — a
code from last March is not something you are waiting for.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `otp-code.enabled` | `true` | Surface codes at all |
| `otp-code.tagEmails` | `true` | Also tag the message `otp` |
| `otp-code.minConfidence` | `0.55` | How certain the detector must be. Raise it if you see false positives, lower it if codes are being missed |

## How detection works

Detection is a small, pure, unit-tested function — `src/otp-detect.ts` — not a
model and not a network call. It:

1. Scans the first 2,000 characters of the subject and the body. The bound is
   deliberate: a newsletter must never be able to stall the main thread.
2. Collects candidates — 4-8 digit runs, grouped forms like `123 456`, and
   uppercase alphanumeric codes like `4F7K2A`.
3. Rejects anything whose neighbouring characters make it a price, a
   percentage, a URL fragment, a decimal or a version number.
4. Scores each candidate on how close it sits to passcode wording
   ("verification code", "OTP", "your code is"), whether it is in the subject,
   and its shape. Four-digit years are penalised heavily.
5. Returns the best candidate at or above the confidence floor, or nothing.

If no passcode wording appears within 60 characters of a number, that number is
not a code — this is what keeps order numbers and invoice totals off the card.

### Why this is hand-rolled

The house rule is to prefer a maintained library over bespoke regex, and it was
checked first. There is no maintained npm package for extracting OTPs from
email: the few that exist are single-regex, unmaintained and archived, and
Apple's `@`-marker convention is SMS-only. So this is kept small, pure,
documented and covered by tests instead, and every pattern is bounded and
non-nested so it cannot backtrack.

## Developing

```sh
pnpm install
pnpm --filter @sarvinbox-ext/otp-code test        # unit tests
pnpm --filter @sarvinbox-ext/otp-code type-check
pnpm --filter @sarvinbox-ext/otp-code build       # bundles to dist/index.js
```

The build produces a single self-contained CommonJS file. `@sarvinbox/core` is
imported for types only, so nothing is required at runtime and the folder can
be dropped anywhere the app can read.

See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for the extension API, the
permission model and how to publish one of your own.

## Privacy

Everything happens on your machine. The extension has no `network:fetch`
permission and no `ai:use` permission, so message content cannot leave the app
through it — the manifest is the enforcement, not a promise.
