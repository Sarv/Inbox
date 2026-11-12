/**
 * What runs inside the extension sandbox: the engine and its CommonJS loader.
 *
 * A separate entry point so it bundles for a Web Worker, where the package barrel
 * (imapflow, nodemailer, better-sqlite3 wiring) cannot load. Everything reachable
 * from here must be free of Node modules: a test bundles it for the browser and
 * fails on the first one.
 */

export {
  startExtensionSandbox,
  type ExtensionSandbox,
  type SandboxExtensionModule,
  type SandboxModuleLoader,
} from './extensions/runtime/sandbox';
export {
  createCommonJsLoader,
  type CommonJsFactory,
  type CommonJsLoader,
  type CommonJsLoaderOptions,
} from './extensions/runtime/commonjs-loader';
export type { ExtensionChannel } from './extensions/runtime/protocol';
