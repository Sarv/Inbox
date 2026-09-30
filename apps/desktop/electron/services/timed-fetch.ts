/**
 * Chromium's fetch with a deadline on the connection AND on the body read, in
 * the `FetchLike` shape core's bounded readers take. One implementation for
 * every main-process lookup that asks a third-party server something (BIMI
 * logos, favicons, OpenPGP key discovery): a server that hangs must not hold a
 * slot, or a compose window, for long.
 */
import { withTimeout, type FetchLike } from '@sarvinbox/core';

import { chromiumFetch } from './net-fetch';

export function timedChromiumFetch(timeoutMs: number): FetchLike {
  return async (url) => {
    const res = await withTimeout(chromiumFetch(url), timeoutMs, `Timed out fetching ${url}`);
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      headers: { get: (name: string) => res.headers.get(name) },
      arrayBuffer: () => withTimeout(res.arrayBuffer(), timeoutMs, `Timed out reading ${url}`),
    };
  };
}
