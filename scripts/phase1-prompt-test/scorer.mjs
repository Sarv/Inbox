// Quality scoring for Phase 1 LLM responses.
//
// Checks every dimension we've actually been bitten by:
//   • JSON parses? (if not, prompt's JSON instructions are weak)
//   • messages array present? (if not, model returned wrong shape)
//   • Did model truncate? (finish_reason: "length")
//   • Are senders real (appear in source body)?
//   • Are bodies grounded (≥60% words from source)?
//   • Are from_address fields plain strings (not "[email](mailto:email)")?
//   • Do mentions sneak into class= attrs?
//
// Returns a scorecard the runner prints.

const MARKDOWN_AUTOLINK_RE = /\[[^\]]+\]\(mailto:[^)]+\)/i;
const FAKE_CLASS_MENTION_RE = /class\s*=\s*["']@/i;

function tokenize(s) {
  return new Set(
    String(s || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 4),
  );
}

function tokenOverlap(candidate, source) {
  const c = tokenize(candidate);
  if (c.size === 0) return 1;
  const s = tokenize(source);
  let common = 0;
  for (const t of c) if (s.has(t)) common++;
  return common / c.size;
}

export function score(fixture, modelName, llmResponse, finishReason) {
  const result = {
    model: modelName,
    parsed: false,
    parseError: null,
    truncated: finishReason === 'length',
    finishReason,
    rawContent: '',
    messagesCount: 0,
    expectedMin: fixture.expectedMinMessages || 1,
    expectedMax: fixture.expectedMaxMessages || 99,
    sendersFound: [],
    sendersExpected: fixture.expectedSenders || [],
    sendersGrounded: 0,
    sendersGroundedPct: 0,
    bodiesAvgGrounded: 0,
    issues: [],
    verdict: 'UNKNOWN',
  };

  const content = llmResponse?.choices?.[0]?.message?.content || '';
  result.rawContent = content;

  if (result.truncated) {
    result.issues.push(`Response truncated (finish_reason: "length", completion_tokens: ${llmResponse?.usage?.completion_tokens || '?'})`);
  }

  // Try to parse — strip leading/trailing whitespace, markdown fences if present.
  let parsed;
  try {
    let s = content.trim();
    if (s.startsWith('```json')) s = s.slice(7);
    else if (s.startsWith('```')) s = s.slice(3);
    if (s.endsWith('```')) s = s.slice(0, -3);
    parsed = JSON.parse(s.trim());
    result.parsed = true;
  } catch (e) {
    result.parseError = e.message;
    result.issues.push(`JSON parse failed: ${e.message}`);
    result.verdict = 'PARSE_FAIL';
    return result;
  }

  let arr = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.messages)) arr = parsed.messages;

  if (!arr) {
    result.issues.push(`Response has no "messages" array. Top-level keys: ${Object.keys(parsed || {}).join(', ') || '(none)'}`);
    result.verdict = 'WRONG_SHAPE';
    return result;
  }

  result.messagesCount = arr.length;

  if (arr.length < result.expectedMin) {
    result.issues.push(`Too few messages: got ${arr.length}, expected ≥ ${result.expectedMin}`);
  }
  if (arr.length > result.expectedMax) {
    result.issues.push(`Too many messages: got ${arr.length}, expected ≤ ${result.expectedMax}`);
  }

  const sourceLower = (fixture.body || '').toLowerCase();
  const expectedSendersLower = (fixture.expectedSenders || []).map(s => s.toLowerCase());
  let bodiesGroundedTotal = 0;
  let bodiesGroundedCount = 0;

  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    const fromAddr = String(m?.from_address || '').toLowerCase().trim();
    const body = String(m?.body || '');

    if (MARKDOWN_AUTOLINK_RE.test(fromAddr)) {
      result.issues.push(`Message[${i}] from_address is in markdown form: "${fromAddr.slice(0, 60)}"`);
    }
    if (FAKE_CLASS_MENTION_RE.test(body)) {
      result.issues.push(`Message[${i}] body has fake class= attribute (likely from @-mention misparse)`);
    }
    if (fromAddr) result.sendersFound.push(fromAddr);
    if (body) {
      bodiesGroundedTotal += tokenOverlap(body, fixture.body);
      bodiesGroundedCount++;
    }
  }

  // Sender grounding: how many of the EXPECTED senders did we find?
  const foundLower = new Set(result.sendersFound);
  result.sendersGrounded = expectedSendersLower.filter(s => foundLower.has(s)).length;
  result.sendersGroundedPct = expectedSendersLower.length > 0
    ? Math.round((result.sendersGrounded / expectedSendersLower.length) * 100)
    : 100;

  // Body grounding: avg overlap of returned bodies with source
  result.bodiesAvgGrounded = bodiesGroundedCount > 0
    ? Math.round((bodiesGroundedTotal / bodiesGroundedCount) * 100)
    : 0;

  if (result.sendersGroundedPct < 50) {
    result.issues.push(`Low sender grounding: ${result.sendersGrounded}/${expectedSendersLower.length} expected senders found (${result.sendersGroundedPct}%)`);
  }
  if (result.bodiesAvgGrounded < 60) {
    result.issues.push(`Low body grounding: avg ${result.bodiesAvgGrounded}% of body words appear in source`);
  }

  // Hallucinated senders — return addresses that aren't in source body anywhere
  const hallucinated = result.sendersFound.filter(s => {
    if (!s) return false;
    if (sourceLower.includes(s)) return false;
    const local = s.split('@')[0];
    if (local && local.length >= 3 && sourceLower.includes(local)) return false;
    return true;
  });
  if (hallucinated.length > 0) {
    result.issues.push(`Possibly hallucinated senders (not in source body): ${hallucinated.join(', ')}`);
  }

  // Final verdict
  if (result.issues.length === 0) {
    result.verdict = 'GOOD';
  } else if (result.truncated || result.messagesCount < result.expectedMin) {
    result.verdict = 'BAD';
  } else if (result.sendersGroundedPct >= 70 && result.bodiesAvgGrounded >= 60) {
    result.verdict = 'OK_WITH_WARNINGS';
  } else {
    result.verdict = 'BAD';
  }
  return result;
}

export function printScorecard(scorecard) {
  const verdict = scorecard.verdict;
  const verdictColor =
    verdict === 'GOOD' ? '\x1b[32m' :
    verdict === 'OK_WITH_WARNINGS' ? '\x1b[33m' :
    '\x1b[31m';
  const reset = '\x1b[0m';

  console.log('');
  console.log('━'.repeat(70));
  console.log(`Model:               ${scorecard.model}`);
  console.log(`Verdict:             ${verdictColor}${verdict}${reset}`);
  console.log(`finish_reason:       ${scorecard.finishReason}${scorecard.truncated ? ' ⚠️  TRUNCATED' : ''}`);
  console.log(`Parsed JSON:         ${scorecard.parsed ? '✓' : '✗ ' + (scorecard.parseError || '')}`);
  console.log(`Messages returned:   ${scorecard.messagesCount} (expected ${scorecard.expectedMin}–${scorecard.expectedMax})`);
  console.log(`Expected senders:    ${scorecard.sendersGrounded}/${scorecard.sendersExpected.length} found (${scorecard.sendersGroundedPct}%)`);
  console.log(`Body grounding:      avg ${scorecard.bodiesAvgGrounded}% words from source`);
  if (scorecard.issues.length > 0) {
    console.log('Issues:');
    for (const issue of scorecard.issues) console.log('  • ' + issue);
  }
  console.log('━'.repeat(70));
}
