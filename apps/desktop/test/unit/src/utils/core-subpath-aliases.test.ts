import { readFileSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, resolve } from 'path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FORBIDDEN_RENDERER_PACKAGES } from '../../../../vite/forbid-node-only-renderer';
import { rendererAliases } from '../../../../vite/renderer-aliases';

// What breaks if this file fails: the renderer's deep imports of core. Each
// `@sarvinbox/core/<name>` alias points the renderer at ONE pure core source
// file instead of the core barrel, whose transports (imapflow, mailparser,
// nodemailer) crash the window on first paint. Two ways that goes wrong
// without anything failing at the time:
//
//   * the Vite alias and the tsconfig path drift apart — the code typechecks
//     against one file and runs against another (or does not resolve at all);
//   * an aliased module grows an import that reaches a Node-only package, the
//     core barrel, or the mailguard ROOT entry. Nothing imports the new
//     aliases from the renderer yet, so the build-time bundle guard cannot see
//     them; this walks their import graph statically instead.

const DESKTOP = resolve(__dirname, '../../../..');
const CORE_SRC = resolve(DESKTOP, '../../packages/core/src');

const aliases = new Map(
  rendererAliases(DESKTOP).map((a) => [String(a.find), String(a.replacement)] as const),
);
const coreAliases = [...aliases].filter(([find]) => find.startsWith('@sarvinbox/core/'));

/** tsconfig.json has comments; read it the way tsc does. */
function tsconfigPaths(): Record<string, string[]> {
  const file = resolve(DESKTOP, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(file, (p) => readFileSync(p, 'utf8'));
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  return (config.compilerOptions?.paths ?? {}) as Record<string, string[]>;
}

/**
 * Value (non-type) module specifiers of one source file. Type-only imports and
 * exports are erased by the compiler and never reach the bundle, so they are
 * skipped — that is the discipline the renderer relies on for the core barrel.
 */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = !!clause && (clause.isTypeOnly
        || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0
          && clause.namedBindings.elements.every((el) => el.isTypeOnly)));
      if (!typeOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteral(arg)) specs.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

/** Resolve a relative specifier the way the bundler does for these TS sources. */
function resolveRelative(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), base]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

/** Every bare package specifier reachable from `entry` through relative value imports. */
function reachablePackages(entry: string): { packages: Set<string>; files: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of valueImports(file)) {
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
      else packages.add(spec);
    }
  }
  return { packages, files };
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const FORBIDDEN = new Set(DEFAULT_FORBIDDEN_RENDERER_PACKAGES);

/** The package a bare specifier names (`@scope/name/sub` -> `@scope/name`). */
const packageOf = (spec: string): string => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

describe('renderer core-subpath aliases', () => {
  // Breaks: code typechecks against one file and the renderer loads another,
  // or an alias exists for Vite but not for tsc (or the reverse).
  it('every core alias has an identical tsconfig path, and vice versa', () => {
    const paths = tsconfigPaths();
    for (const [find, replacement] of coreAliases) {
      expect(paths[find], `tsconfig paths is missing ${find}`).toBeDefined();
      expect(resolve(DESKTOP, paths[find][0]), find).toBe(replacement);
    }
    for (const key of Object.keys(paths).filter((k) => k.startsWith('@sarvinbox/core/'))) {
      expect(aliases.has(key), `renderer-aliases.ts is missing ${key}`).toBe(true);
    }
  });

  // Breaks: a Node-only package, the core barrel or the mailguard root entry
  // leaks into the renderer through an aliased core module — the blank-window
  // crash the bundle guard exists for, but on a module nothing bundles yet.
  it.each(coreAliases)('%s reaches no Node-only package, builtin or barrel', (_find, replacement) => {
    const { packages, files } = reachablePackages(replacement);
    for (const spec of packages) {
      expect(FORBIDDEN.has(packageOf(spec)), `${spec} is forbidden in the renderer`).toBe(false);
      expect(NODE_BUILTINS.has(spec), `${spec} is a Node builtin`).toBe(false);
      expect(spec, 'the core barrel').not.toBe('@sarvinbox/core');
      expect(spec, "mailguard's root entry reaches free-email-domains").not.toBe('@sarv-in/mailguard');
    }
    expect(files.has(resolve(CORE_SRC, 'index.ts')), 'reaches the core barrel').toBe(false);
    expect(files.has(resolve(CORE_SRC, 'utils/index.ts')), 'reaches the utils barrel').toBe(false);
  });

  // Breaks: the walk above silently checks nothing (a resolver bug that stops
  // at the entry would make every graph look clean). Asserted on whichever
  // aliased module has relative imports, so it keeps working as aliases change.
  it('walks relative imports transitively', () => {
    const withRelatives = coreAliases
      .map(([, replacement]) => reachablePackages(replacement))
      .find(({ files }) => files.size > 1);
    expect(withRelatives, 'no aliased module has a relative import to walk').toBeDefined();
  });

  // Breaks: the walk stops after one hop, so ai-error's second-level import
  // (imap-errors -> oauth-errors) or quoted-text's leaf packages go unchecked
  // and a Node-only package two files deep reaches the renderer unseen.
  it('walks the AI-view aliases to their second-level imports and leaf packages', () => {
    const { files, packages } = reachablePackages(resolve(CORE_SRC, 'utils/ai-error.ts'));
    expect(files).toContain(resolve(CORE_SRC, 'imap/imap-errors.ts'));
    expect(files).toContain(resolve(CORE_SRC, 'oauth/oauth-errors.ts'));
    const quoted = reachablePackages(resolve(CORE_SRC, 'utils/quoted-text.ts'));
    expect(quoted.packages).toContain('@sarv-in/mailguard/quote');
    expect(quoted.packages).toContain('html-to-text');
    expect(packages.size).toBe(0);
  });

  // Breaks: an alias added for the AI-view redesign does not resolve under the
  // renderer's own resolver config (vitest runs with the same aliases), or
  // resolves to a module without the exports the renderer will call.
  it('resolves every alias added for the conversation/first-split work', async () => {
    const membership = await import('@sarvinbox/core/conversation-membership');
    expect(membership.conversationMembers([
      { id: 'b', date: 2, tags: '|INBOX|' },
      { id: 'd', date: 3, tags: '|Drafts|' },
      { id: 'a', date: 1, tags: '|INBOX|' },
    ]).map((r) => r.id)).toEqual(['a', 'b']);

    const firstSplit = await import('@sarvinbox/core/first-split');
    expect(firstSplit.FIRST_SPLIT_VERSION).toBeGreaterThan(0);
    expect(firstSplit.firstMemberKeyOf({ id: 'x', messageId: '<A@h>' })).toBe('a@h');

    const quoted = await import('@sarvinbox/core/quoted-text');
    expect(quoted.quoteMarkerCount('Hi\n> a\n> > b', 'text')).toBe(2);

    const htmlText = await import('@sarvinbox/core/html-text');
    expect(htmlText.htmlToPlainText('<p>Hello <b>there</b></p>').trim()).toBe('Hello there');

    const fnv = await import('@sarvinbox/core/fnv1a');
    expect(fnv.fnv1a32('foobar')).toBe(0xbf9cf968);

    const aiError = await import('@sarvinbox/core/ai-error');
    expect(aiError.classifyAIError(Object.assign(new Error('Too Many Requests'), { status: 429 })).kind)
      .toBe('rate_limit');
  });

  // Breaks: the renderer's structured logger does not resolve under the
  // renderer's own resolver config (vitest runs with the same aliases), so
  // renderer code falls back to raw console output that app.log cannot parse.
  it('resolves the renderer logger alias', async () => {
    const logger = await import('@sarvinbox/core/logger');
    expect(typeof logger.createLogger('AliasTest').info).toBe('function');
  });
});
