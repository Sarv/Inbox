# Phase 1 Prompt Test Harness

Iterate on the Phase 1 "split email into messages" prompt without rebuilding
the Electron app. Pulls real email bodies from your Sarvinbox SQLite DB,
sends them through the prompt to a chosen LLM, and reports quality metrics.

## Why this exists

The Phase 1 prompt is sensitive to model choice. `gpt-oss-120b` and
`sarv-mati-flash` produce very different outputs for the same input —
one truncates at 256 tokens, the other returns the wrong field shape,
etc. Editing the prompt and rebuilding the app every iteration is slow.

This script is a fast feedback loop: edit `prompt.mjs`, run, see results.

## Setup

1. Get a bearer token from a running Sarvinbox session — DevTools →
   Network → any LLM request → copy the `Authorization` header value
   (just the token after "Bearer ").
2. Export it:
   ```sh
   export SARV_LLM_BEARER='eyJhbGciOiJSUzI1...'
   ```
3. (Optional) override the API base:
   ```sh
   export SARV_LLM_BASE='http://localhost:9091/edge/v1/llm'
   ```

## Usage

### Run against a fixture (built-in test case)

```sh
node scripts/phase1-prompt-test/run.mjs --model gpt-oss-120b --fixture nested-outlook-thread
node scripts/phase1-prompt-test/run.mjs --model sarv-mati-flash --fixture nested-outlook-thread
```

### Run against a real email from your DB

```sh
node scripts/phase1-prompt-test/run.mjs --model gpt-oss-120b --email-id <id-from-your-emails-table>
```

### Compare multiple models side-by-side

```sh
node scripts/phase1-prompt-test/run.mjs --fixture nested-outlook-thread --models gpt-oss-120b,sarv-mati-flash
```

## Iterating on the prompt

1. Edit `prompt.mjs` — adjust system prompt, examples, schema.
2. Re-run.
3. Look at the **scorecard** in the output:
   - `parsed`: did JSON parse cleanly?
   - `messages_count`: how many messages came back
   - `expected_count`: how many we expected (per fixture)
   - `senders_grounded`: % of returned `from_address` that appear in source
   - `bodies_grounded`: avg % of body words present in source
   - `truncated`: did `finish_reason` say "length"?
4. Tweak prompt, repeat.

**`prompt.mjs` holds the retired V1 prompt — do not paste it back into the
app.** It asks for ISO-8601 dates, so the model guesses the day/month order
(a 7 Aug mail can come back as Jul 8), and it has no `[[REGION k]]` protocol.
The prompts the app actually sends are `OWN_CHUNK_PROMPT` /
`HISTORY_CHUNK_PROMPT`, returned by `systemPromptFor()` in
`apps/desktop/src/services/first-split/prompt.ts`; they ask for each date
verbatim so `parseHumanDate` reads it day-first. A result from this harness
says nothing about those prompts — port the harness to them before using it
to evaluate the live split.

## What lives where

| File | Purpose |
|---|---|
| `run.mjs` | The runner. Loads fixture/email, builds prompt, hits LLM, scores. |
| `prompt.mjs` | The retired V1 system + user prompt (not the app's live prompt — see above). |
| `fixtures/*.json` | Pre-saved test cases — body + expected message count + expected senders. Fully synthetic (pseudonymous cast, `partner.example` customer, ticket 400123) — never commit a real mailbox body here. |
| `scorer.mjs` | Quality checks (grounding, parse, truncation). |
