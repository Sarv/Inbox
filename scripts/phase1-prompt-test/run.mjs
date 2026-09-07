#!/usr/bin/env node
// Phase 1 prompt test harness — see ./README.md
//
// Edits → re-run → see scorecard. No app rebuild needed.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SYSTEM_PROMPT_V1, SYSTEM_PROMPT_V2, SYSTEM_PROMPT_V3, buildUserPrompt } from './prompt.mjs';
import { score, printScorecard } from './scorer.mjs';
import { compressToPlainText, compressToFit, estimateTokens } from './compress.mjs';
import { appDataBase } from '../lib/userdata-dirs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_VARIANTS = {
  v1: SYSTEM_PROMPT_V1,
  v2: SYSTEM_PROMPT_V2,
  v3: SYSTEM_PROMPT_V3,
};

// Known per-model context windows so we can budget the body size.
// Pulled from deployment commands. Override with --max-model-len.
const MODEL_CONTEXT = {
  'sarv-mati-flash': 16384,       // gemma-4-26B-A4B-it, --max-model-len 16384
  'gpt-oss-120b': 32768,          // typical
};

// CLI parsing — keep it dependency-free.
function parseArgs(argv) {
  const out = {
    models: [],
    fixture: null,
    emailId: null,
    prompt: 'v2',
    maxTokens: 16384,
    compress: 'auto', // 'none' | 'plaintext' | 'fit' | 'auto'
    maxModelLen: null, // override per-model context window
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.models.push(argv[++i]);
    else if (a === '--models') out.models.push(...argv[++i].split(','));
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--email-id') out.emailId = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--max-tokens') out.maxTokens = parseInt(argv[++i], 10);
    else if (a === '--compress') out.compress = argv[++i];
    else if (a === '--max-model-len') out.maxModelLen = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  if (out.models.length === 0) out.models = ['gpt-oss-120b'];
  if (!out.fixture && !out.emailId) out.fixture = 'nested-outlook-thread';
  return out;
}

function printHelp() {
  console.log(`Phase 1 prompt test harness

Usage:
  node run.mjs [options]

Options:
  --model NAME           LLM model name (default: gpt-oss-120b)
  --models a,b,c         Multiple models, comma-separated, run sequentially
  --fixture NAME         Fixture from ./fixtures/<name>.json (default: nested-outlook-thread)
  --email-id ID          Email id from your sarvinbox.db (overrides fixture)
  --prompt v1|v2|v3      Which system prompt to use (default: v2)
                           v1: original, with 1 small example
                           v2: hardened, anti-pattern examples (best for big-context models)
                           v3: ultra-terse, tuned for 4K-context models
  --compress MODE        Body compression (default: auto)
                           none:      send raw HTML body (only safe with big-context models)
                           plaintext: HTML→plain text, keep all depth (5-10x smaller)
                           fit:       plaintext + drop deepest history until it fits budget
                           auto:      pick based on model context: 'fit' for ≤8K, 'plaintext' otherwise
  --max-tokens N         max_completion_tokens to send (default: 16384)
  --max-model-len N      Override per-model context window (default: lookup table)
  -h, --help             Show this

Env:
  SARV_LLM_BEARER        Bearer token (required) — copy from DevTools Network → any LLM call
  SARV_LLM_BASE          API base (default: http://localhost:9091/edge/v1/llm)

Known model context windows:
${Object.entries(MODEL_CONTEXT).map(([k, v]) => `  ${k}: ${v}`).join('\n')}
`);
}

async function loadFixture(name) {
  const path = join(__dirname, 'fixtures', `${name}.json`);
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

async function loadFromDb(emailId) {
  // Lazy-load better-sqlite3 — only needed when --email-id is used.
  const { default: Database } = await import('better-sqlite3').catch(() => {
    throw new Error('better-sqlite3 not available — run `pnpm i` at repo root or use --fixture instead');
  });
  // Try the standard Sarvinbox DB location — the platform's userData dir
  // (macOS / Windows / Linux — see scripts/lib/userdata-dirs.mjs).
  const dbPath = join(appDataBase(), 'Sarv Inbox', 'sarvinbox.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(`
    SELECT id, from_address, from_name, to_address, date, raw_body, clean_body, subject
    FROM emails WHERE id = ?
  `).get(emailId);
  db.close();
  if (!row) throw new Error(`Email ${emailId} not found in DB at ${dbPath}`);
  return {
    name: `db-${emailId}`,
    description: `Email ${emailId} from DB: ${row.subject}`,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddress: row.to_address || '',
    date: new Date((row.date || 0) * 1000).toISOString(),
    body: row.raw_body || row.clean_body || '',
    expectedSenders: [],
    expectedMinMessages: 1,
    expectedMaxMessages: 99,
  };
}

async function callLLM({ model, systemPrompt, userPrompt, maxTokens, bearer, baseUrl }) {
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: 'minimal',
    reasoning: { effort: 'minimal' },
    response_format: { type: 'json_object' },
  };
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return { json, latencyMs };
}

async function main() {
  const args = parseArgs(process.argv);
  const bearer = process.env.SARV_LLM_BEARER;
  const baseUrl = process.env.SARV_LLM_BASE || 'http://localhost:9091/edge/v1/llm';
  if (!bearer) {
    console.error('ERROR: SARV_LLM_BEARER env var is not set.');
    console.error('Get a token: open Sarvinbox, DevTools → Network → any LLM call → copy Authorization header.');
    process.exit(1);
  }
  const systemPrompt = PROMPT_VARIANTS[args.prompt];
  if (!systemPrompt) {
    console.error(`Unknown prompt variant: ${args.prompt}. Available: ${Object.keys(PROMPT_VARIANTS).join(', ')}`);
    process.exit(1);
  }

  const fixture = args.emailId
    ? await loadFromDb(args.emailId)
    : await loadFixture(args.fixture);

  const systemTokens = estimateTokens(systemPrompt);
  const rawBodyChars = fixture.body.length;
  const rawBodyTokens = estimateTokens(fixture.body);

  console.log('');
  console.log('═'.repeat(70));
  console.log(`Fixture:     ${fixture.name}`);
  console.log(`Description: ${fixture.description || '(none)'}`);
  console.log(`Raw body:    ${rawBodyChars} chars ≈ ${rawBodyTokens} tokens`);
  console.log(`System:      ${args.prompt} (${systemPrompt.length} chars ≈ ${systemTokens} tokens)`);
  console.log(`Models:      ${args.models.join(', ')}`);
  console.log('═'.repeat(70));

  for (const model of args.models) {
    console.log('');
    console.log(`▶ Running ${model}...`);

    // Decide context window for this model.
    const ctxWindow = args.maxModelLen ?? MODEL_CONTEXT[model] ?? 32768;
    // Reserve room for the response. Default: 25% of context, capped at maxTokens.
    const responseBudget = Math.min(args.maxTokens, Math.floor(ctxWindow * 0.25));
    // Body budget = ctxWindow − systemPrompt − response − some metadata overhead.
    const overhead = systemTokens + responseBudget + 200;
    const bodyTokenBudget = Math.max(200, ctxWindow - overhead);
    // Convert tokens back to a char budget (~3.5 chars/token).
    const bodyCharBudget = bodyTokenBudget * 3;

    // Decide compression mode.
    let compressMode = args.compress;
    if (compressMode === 'auto') {
      compressMode = ctxWindow <= 8192 ? 'fit' : (ctxWindow <= 16384 ? 'plaintext' : 'none');
    }

    // Apply compression.
    let body = fixture.body;
    let compressionInfo = '';
    if (compressMode === 'plaintext') {
      body = compressToPlainText(fixture.body);
      compressionInfo = `plaintext (${rawBodyChars}→${body.length} chars, ${Math.round((1 - body.length / rawBodyChars) * 100)}% smaller)`;
    } else if (compressMode === 'fit') {
      const fit = compressToFit(fixture.body, bodyCharBudget);
      body = fit.body;
      compressionInfo = `fit (depth=${fit.finalDepth}, ${rawBodyChars}→${fit.compressedChars} chars, budget=${bodyCharBudget})`;
    } else {
      compressionInfo = 'none';
    }

    const userPrompt = buildUserPrompt(fixture, body);
    const userTokens = estimateTokens(userPrompt);
    const totalTokens = systemTokens + userTokens + responseBudget;

    console.log(`  Context window: ${ctxWindow} tokens`);
    console.log(`  Compression:    ${compressionInfo}`);
    console.log(`  Token budget:   sys ${systemTokens} + user ${userTokens} + response ${responseBudget} = ${totalTokens} (limit ${ctxWindow})`);
    if (totalTokens > ctxWindow) {
      console.log(`  ⚠️  OVER BUDGET by ${totalTokens - ctxWindow} tokens — model will silently truncate input.`);
    }

    let response;
    try {
      response = await callLLM({ model, systemPrompt, userPrompt, maxTokens: responseBudget, bearer, baseUrl });
    } catch (err) {
      console.error(`✗ ${model} request failed: ${err.message}`);
      continue;
    }
    const finishReason = response.json?.choices?.[0]?.finish_reason || 'unknown';
    const usage = response.json?.usage || {};
    console.log(`✓ ${model} responded in ${response.latencyMs}ms (prompt ${usage.prompt_tokens || '?'} + completion ${usage.completion_tokens || '?'} = ${usage.total_tokens || '?'} tokens)`);
    const card = score(fixture, model, response.json, finishReason);
    printScorecard(card);
    if (card.verdict === 'GOOD' || card.verdict === 'OK_WITH_WARNINGS') {
      // Show a preview of the parsed messages
      try {
        let s = card.rawContent.trim();
        if (s.startsWith('```json')) s = s.slice(7);
        else if (s.startsWith('```')) s = s.slice(3);
        if (s.endsWith('```')) s = s.slice(0, -3);
        const parsed = JSON.parse(s.trim());
        const msgs = Array.isArray(parsed) ? parsed : parsed.messages;
        console.log('Returned messages (preview):');
        msgs.forEach((m, i) => {
          const bodyPreview = String(m.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
          console.log(`  ${i + 1}. ${m.from_address || '(no addr)'} | ${m.date || '(no date)'} | ${bodyPreview}${bodyPreview.length === 80 ? '…' : ''}`);
        });
      } catch { /* ignore preview errors */ }
    } else {
      // For bad outputs, dump the raw content head/tail so we can see what went wrong
      console.log('Raw content (first 300 chars):');
      console.log('  ' + card.rawContent.slice(0, 300));
      if (card.rawContent.length > 600) {
        console.log('Raw content (last 200 chars):');
        console.log('  ' + card.rawContent.slice(-200));
      }
    }
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
