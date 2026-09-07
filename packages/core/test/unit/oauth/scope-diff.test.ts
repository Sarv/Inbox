import { describe, expect, it } from 'vitest';

import { scopesLost, scopesNotGranted } from '../../../src/oauth/scope-diff';

// These two helpers exist to make one specific failure diagnosable: the token
// works for mail but every AI call 403s. That happens when `llm:view` was never
// granted, or was granted and then dropped by a refresh — and nothing in the app
// used to record either. A regression here puts that back to guesswork.

describe('scopesNotGranted', () => {
  // The sign-in case: an authorization server may silently drop a scope it does
  // not allow rather than failing the request, so "sign-in worked" proves nothing.
  it('names the requested scopes the server withheld', () => {
    expect(scopesNotGranted(['openid', 'email', 'llm:view', 'llm:query'], ['openid', 'email']))
      .toEqual(['llm:query', 'llm:view']);
  });

  it('reports nothing when the full request was granted', () => {
    expect(scopesNotGranted(['openid', 'llm:view'], ['llm:view', 'openid'])).toEqual([]);
  });

  // A server returning MORE than was asked for is not a problem to report.
  it('ignores extra scopes the server threw in', () => {
    expect(scopesNotGranted(['openid'], ['openid', 'profile'])).toEqual([]);
  });
});

describe('scopesLost', () => {
  // THE regression this was written for: a narrowing refresh leaves the account
  // signed in and mail syncing, and only the dropped scope starts failing.
  it('names the scopes a refresh dropped', () => {
    expect(scopesLost(['email:read', 'llm:view', 'llm:query'], ['email:read']))
      .toEqual(['llm:query', 'llm:view']);
  });

  // The common, boring case must stay silent or the warning becomes noise that
  // gets ignored on the day it matters.
  it('reports nothing for an unchanged grant, whatever the order', () => {
    expect(scopesLost(['llm:view', 'email:read'], ['email:read', 'llm:view'])).toEqual([]);
  });

  it('reports nothing for a widened grant', () => {
    expect(scopesLost(['email:read'], ['email:read', 'llm:view'])).toEqual([]);
  });

  // Servers vary in how they serialize a scope string; whitespace and repeats
  // are formatting, not a change of grant.
  it('treats duplicates and stray whitespace as the same grant', () => {
    expect(scopesLost([' llm:view ', 'llm:view', 'email:read'], ['email:read', 'llm:view']))
      .toEqual([]);
  });

  // A refresh that returns no scope at all is "unchanged" upstream (the caller
  // keeps the stored list), so it must never be reported as a total loss.
  it('reports every scope only when the new grant is genuinely empty', () => {
    expect(scopesLost(['llm:view'], [])).toEqual(['llm:view']);
    expect(scopesLost([], [])).toEqual([]);
  });
});
