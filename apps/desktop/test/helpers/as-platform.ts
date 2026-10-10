/**
 * Run `fn` with `process.platform` reporting `platform`, then restore it — for
 * platform-specific branches that must be tested on every CI runner, not only
 * on the one platform they're about (e.g. Linux keyring handling, tested on a Mac).
 */
export function asPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}
