/**
 * Loading an extension with Node's own `require`, for hosts with no confinement.
 *
 * The CLI and the test suites run the sandbox engine in-process and load
 * extensions this way. The desktop app never does: its engine runs in a Web
 * Worker with the loader in `commonjs-loader.ts`. This lives apart from the
 * engine because the engine has to bundle for a Worker, where `module` does not
 * exist.
 */

import { createRequire } from 'module';
import { join } from 'path';

import type { SandboxExtensionModule, SandboxModuleLoader } from './sandbox';

/**
 * A `require` rooted at the extension's own entry point.
 *
 * Rooting it there rather than at this file is what lets a no-build extension
 * `require('./helpers')` and get the file next to it. The cache line makes a
 * reload actually re-read the source instead of handing back the copy from the
 * last activation.
 *
 * @param rootDir the extension's folder; the entry point arrives relative to it
 */
export function createNodeModuleLoader(rootDir: string): SandboxModuleLoader {
  return (entryPoint) => {
    const absolute = join(rootDir, entryPoint);
    const requireFromExtension = createRequire(absolute);
    delete requireFromExtension.cache[requireFromExtension.resolve(absolute)];
    return requireFromExtension(absolute) as SandboxExtensionModule;
  };
}
