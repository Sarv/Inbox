import { readFileSync } from 'fs';
import { resolve } from 'path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A static guard over the renderer files whose AI features handle mail and the
 * user's own words: no log call in them may print the value of a variable that
 * holds that text. A log argument may use such a variable only reduced to
 * metadata — `x.length`, `!x` / `!!x`, `typeof x`, the condition of `x ? a : b`,
 * `Array.isArray(x)`, `errorDiagnostic(x)`, one of the log-text reducers
 * (`setFieldNamesForLog(x)`, `fieldSizesForLog(x)`, `valueShapeForLog(x)`,
 * `urlSchemeForLog(x)`) or ai-service's `confidenceLabel(x)`, which answers one
 * of four fixed words. `Object.keys(x)` is NOT metadata: whoever built the
 * object chose its keys (a model, a renderer), and a key can be any text. The
 * reducers name identifier-like keys only and count the rest.
 *
 * What breaks if this file fails: someone adds `console.log('[AI] raw:',
 * responseText)` (or logs the parsed answer, the selector, the sender, the
 * query) back into one of these files, and a release app.log gets mail text
 * again. The behavioural tests (ai-service-log-privacy.test.ts) only cover the
 * paths they drive; this covers every log call in the file.
 */

const DESKTOP = resolve(__dirname, '../../../..');

// A caught error is logged through errorDiagnostic, never whole: its message
// can quote what it was working on (a model's answer, a provider's response
// body, a selector, a file name, the stored JSON it could not parse).
const CAUGHT = ['error', 'err', 'parseError'];

/** Files under guard, and the variables in them that hold mail or user text. */
const GUARDED: Record<string, string[]> = {
  'src/services/ai-service.ts': [
    'responseText', 'parsed', 'sampleHtml', 'signatureText', 'htmlSelector', 'selector', 'senderEmail',
    'emailBody', 'userMessage', 'historyText', 'instructions', 'text', 'query', 'interpretation',
    'emailsText', 'cleanedBody', 'truncatedBody', 'extractedHtml', 'textContent', 'msg', 'message',
    // A polished draft or a signature answer, a thread summary, a cached or
    // common-selector match (selector + the sender's HTML), the thread itself.
    'result', 'summary', 'cached', 'cachedResult', 'commonMatch', 'emails',
    ...CAUGHT,
  ],
  'src/components/PolishModal.tsx': ['result', 'originalText', 'originalSubject', 'polishedResult', 'instructions', 'customInstructions', ...CAUGHT],
  // `context` and `category` carry an AI category slug, which for a custom
  // category is made from the name the user typed.
  'src/store/slices/search-ai-slice.ts': [
    'query', 'searchQuery', 'aiResult', 'interpretation', 'htmlSelector', 'fromAddress', 'body', 'partial',
    'context', 'category', ...CAUGHT,
  ],
  'src/utils/compose-attachments.ts': ['name', 'filename', ...CAUGHT],
};

/** Files that must not log through raw console.* at all (CLAUDE.md). */
const LOGGER_ONLY = [
  'src/services/ai-service.ts', 'src/components/PolishModal.tsx', 'src/utils/compose-attachments.ts',
  'src/store/slices/search-ai-slice.ts',
];

const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);
const METADATA_CALLS = new Set([
  'Array.isArray', 'errorDiagnostic',
  'setFieldNamesForLog', 'fieldSizesForLog', 'valueShapeForLog', 'urlSchemeForLog',
  'confidenceLabel',
]);

/** `console.x(…)`, `logger.x(…)`, `log.x(…)` or `<something>Log.x(…)`. */
function isLogCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !LOG_METHODS.has(callee.name.text)) return false;
  return ts.isIdentifier(callee.expression) && /^console$|log(?:ger)?$/i.test(callee.expression.text);
}

/**
 * Whether `node` (a value expression) is only used as metadata by its parent.
 * Walks up through wrappers that keep the value's meaning (`(x)`, `x ?? y`).
 */
function isMetadataUse(node: ts.Node): boolean {
  const parent = node.parent;
  // `x.length` is metadata; `x.field` is another value, judged by its own use.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text === 'length' || isMetadataUse(parent);
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === node) return true;
  if (ts.isParenthesizedExpression(parent)) return isMetadataUse(parent);
  if (ts.isBinaryExpression(parent) && parent.left === node
    && (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return isMetadataUse(parent);
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const callee = parent.expression.getText();
    if (METADATA_CALLS.has(callee)) return true;
    // String(x).length
    if (callee === 'String') return isMetadataUse(parent);
  }
  return false;
}

/** Every log call in `source` that prints one of `names` as a value, as `line: text`. */
function findMailTextInLogCalls(fileName: string, source: string, names: string[]): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const forbidden = new Set(names);
  const found: string[] = [];
  const inspectArgs = (call: ts.CallExpression) => {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && forbidden.has(node.text)) {
        // `a.b`: the value is the whole access when the name is its property.
        const value = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        // A property NAME in an object literal (`{ query: 1 }`) is not a read.
        const isKey = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
        if (!isKey && !isMetadataUse(value)) {
          const { line } = file.getLineAndCharacterOfPosition(call.getStart());
          found.push(`${line + 1}: ${call.getText().replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const arg of call.arguments) visit(arg);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLogCall(node)) inspectArgs(node);
    ts.forEachChild(node, walk);
  };
  walk(file);
  return [...new Set(found)];
}

/** Every raw `console.*` call in `source`, as `line: text`. */
function findConsoleCalls(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console') {
      found.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText().slice(0, 120)}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

describe('log calls in the AI feature files print no mail or user text', () => {
  // Breaks: see the file header — a log line in one of these files prints a
  // draft, a model answer, a signature, a selector, a sender or a query.
  it.each(Object.entries(GUARDED))('%s', (path, names) => {
    const source = readFileSync(resolve(DESKTOP, path), 'utf8');
    expect(findMailTextInLogCalls(path, source, names)).toEqual([]);
  });

  // Breaks: a raw console.* creeps back into a file migrated to the shared
  // logger (CLAUDE.md: never raw console.* in product code).
  it.each(LOGGER_ONLY)('%s logs through the shared logger only', (path) => {
    expect(findConsoleCalls(path, readFileSync(resolve(DESKTOP, path), 'utf8'))).toEqual([]);
  });
});

/** The `onAICompleteRequest(…)` call in App.tsx: the extension AI bridge. */
function aiBridgeHandler(): string | undefined {
  const source = readFileSync(resolve(DESKTOP, 'src/App.tsx'), 'utf8');
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: string | undefined;
  const walk = (node: ts.Node): void => {
    if (!handler && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'onAICompleteRequest') {
      handler = node.getText();
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return handler;
}

describe('the extension AI bridge in App.tsx logs no prompt, answer or error text', () => {
  // Breaks: `console.error('[AI Bridge] AI completion failed:', error)` comes
  // back. Extensions build their prompts from mail, and a provider's error can
  // carry its response body (the Gemini path throws `API request failed:
  // <status> - <body>`), which can quote that mail; or the bridge starts
  // logging the prompt or the answer, or goes back to raw console output.
  it('logs a failed completion by errorDiagnostic only, through the shared logger', () => {
    const handler = aiBridgeHandler();
    expect(handler, 'the onAICompleteRequest handler moved: point this test at it').toBeDefined();
    expect(findConsoleCalls('bridge.tsx', handler!)).toEqual([]);
    expect(findMailTextInLogCalls('bridge.tsx', handler!, ['systemPrompt', 'userPrompt', 'result', ...CAUGHT])).toEqual([]);
    expect(handler).toMatch(/aiBridgeLog\.error\([^;]*errorDiagnostic\(error\)\)/);
  });
});

describe('the guard itself', () => {
  // Breaks: the guard stops seeing the lines it exists for, and passes on
  // anything — the shapes below are the ones this change removed.
  it('flags the dumps it was written against', () => {
    const source = [
      "console.log('[Signature Detection] Raw AI response:', responseText);",
      "signatureLog.info('Parsed response:', parsed);",
      "log.info(`Cached selector for: ${senderEmail} -> ${result.htmlSelector}`);",
      "console.log('[AI Search] Raw response:', responseText.substring(0, 500));",
      "searchLog.warn('failed', { error, query });",
      "polishLog.warn('x', String(responseText));",
      "logger.error('x', parsed.body);",
      "log.info(responseText.substring(0, 300));",
      "log.info(`fields=${JSON.stringify(parsed)}`);",
      "console.error('[AI Bridge] AI completion failed:', error);",
      // A model's answer keyed by text ({"Jane's payslip": …}) writes that text.
      "log.info(`fields=${Object.keys(parsed).join(',')}`);",
    ].join('\n');
    expect(findMailTextInLogCalls('bad.ts', source, ['responseText', 'parsed', 'senderEmail', 'htmlSelector', 'query', ...CAUGHT])).toHaveLength(11);
  });

  // Breaks: the guard flags the metadata forms the fixed lines use, and gets
  // switched off by the next person it blocks.
  it('allows a value reduced to metadata', () => {
    const source = [
      'log.info(`chars=${responseText.length}`);',
      "log.info(`selector=${result.htmlSelector ? 'present' : 'none'} has=${!!query} t=${typeof parsed}`);",
      "log.info(`fields=${setFieldNamesForLog(parsed ?? {})}`, errorDiagnostic(query));",
      "log.info(`shape=${valueShapeForLog(parsed.query || {})} n=${parsed.items.length}`);",
      'log.info(`n=${Array.isArray(parsed) ? parsed.length : 0} b=${String(parsed).length}`);',
      "log.info('x', { query: 1 });",
      "log.info(`fields=${setFieldNamesForLog(parsed)} shape=${valueShapeForLog(query)} scheme=${urlSchemeForLog(query)}`);",
      'log.info(`sizes=${JSON.stringify(fieldSizesForLog(responseText))} c=${confidenceLabel(parsed.confidence)}`);',
      'cache.info(responseText);',
    ].join('\n');
    expect(findMailTextInLogCalls('ok.ts', source, ['responseText', 'parsed', 'htmlSelector', 'query'])).toEqual([]);
  });
});
