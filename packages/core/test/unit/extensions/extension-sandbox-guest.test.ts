/**
 * What runs inside the sandbox must not reach a Node module, because a Worker has
 * none. A value import of one would fail the desktop build's bundle at best, and at
 * worst load as `require("...")` and crash every extension on start, in a packaged
 * build only. So the import graph of the entry point is walked here.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Value imports only: an `import type` is erased and reaches nothing at runtime. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const found: string[] = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text);
    }
  });
  return found;
}

function walk(file: string, seen: Set<string>, outside: string[]): void {
  if (seen.has(file)) return;
  seen.add(file);
  for (const specifier of valueImports(file)) {
    if (!specifier.startsWith('.')) {
      outside.push(`${specifier} (from ${file})`);
      continue;
    }
    const target = resolve(dirname(file), specifier);
    const resolved = [`${target}.ts`, join(target, 'index.ts')].find(existsSync);
    expect(resolved, `${specifier} from ${file}`).toBeDefined();
    walk(resolved as string, seen, outside);
  }
}

describe('sandbox guest entry', () => {
  // Reach anything outside this package, Node's `module` above all, and the Worker
  // cannot start. The last time that was a default parameter in the engine.
  it('reaches no module outside the package', () => {
    const seen = new Set<string>();
    const outside: string[] = [];
    walk(resolve(__dirname, '../../../src/extension-sandbox-guest.ts'), seen, outside);

    expect(outside).toEqual([]);
    // If this is small the walk stopped early and the check above proves nothing.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  // The other half of the bargain: the package has to publish the entry, or the
  // desktop build falls back to the barrel and every Node module in it.
  it('is a published entry point', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const tsup = readFileSync(resolve(__dirname, '../../../tsup.config.ts'), 'utf8');
    expect(pkg.exports['./extension-sandbox-guest']).toBeDefined();
    expect(tsup).toContain('src/extension-sandbox-guest.ts');
  });
});
