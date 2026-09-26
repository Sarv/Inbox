/* Types for native-abi-args.mjs — see userdata-dirs.d.mts for why these exist. */

/** What scripts/native-abi.mjs was asked to do. */
export type NativeAbiArgs =
  | { kind: 'run'; runtime: 'node' | 'electron'; force: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/** Printed for --help, and after every command line that is refused. */
export declare const USAGE: string;

/** Read the script's arguments (`process.argv.slice(2)`), never guessing. */
export declare function parseNativeAbiArgs(argv: readonly string[]): NativeAbiArgs;
