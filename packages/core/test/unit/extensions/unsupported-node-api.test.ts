/**
 * How an old extension's use of Node reaches the user as a sentence. If this breaks,
 * "process is not defined" is all anyone gets, in a log nobody reads, and the
 * extension just stops doing anything.
 */

import { builtinModules } from 'module';

import { describe, expect, it } from 'vitest';

import {
  isKnownNodeApi,
  nodeApiBehindError,
  nodeBuiltinNamed,
  refusalInConsoleLine,
  UnsupportedNodeApiError,
  unsupportedNodeApiMessage,
} from '../../../src/extensions/runtime/unsupported-node-api';

describe('unsupported Node APIs', () => {
  // The list is written out because the sandbox has no `module.builtinModules`.
  // A Node upgrade adding a builtin must fail here, or a require of it reads as a
  // missing package rather than as what it is.
  it('knows every module the running Node provides', () => {
    const unknown = builtinModules.filter((name) => !name.startsWith('_') && nodeBuiltinNamed(name) === null);
    expect(unknown).toEqual([]);
  });

  // A package whose name merely starts like a builtin is not one.
  it('does not mistake an ordinary package for a builtin', () => {
    expect(nodeBuiltinNamed('lodash')).toBeNull();
    expect(nodeBuiltinNamed('fs-extra')).toBeNull();
    expect(nodeBuiltinNamed('@scope/fs')).toBeNull();
  });

  // `node:` can only ever mean Node, including a module added after this list.
  it('treats anything under node: as a builtin', () => {
    expect(nodeBuiltinNamed('node:something-new')).toBe('something-new');
    expect(nodeBuiltinNamed('fs/promises')).toBe('fs');
  });

  // The name goes into a sentence on a card, so it has to come from these lists.
  it('knows a real API name from anything else', () => {
    expect(isKnownNodeApi('fs')).toBe(true);
    expect(isKnownNodeApi('process')).toBe(true);
    expect(isKnownNodeApi('sign in at evil.example')).toBe(false);
    expect(isKnownNodeApi(42)).toBe(false);
  });

  // The message is the whole point: it names the API and tells the user what to do.
  it('names the API and the way forward, short enough for a card', () => {
    const message = unsupportedNodeApiMessage('child_process');
    expect(message).toContain('"child_process"');
    expect(message).toContain('update');
    // LIMITS.body in ui-notification.ts. Longer is silently cut off on the card.
    expect(message.length).toBeLessThanOrEqual(240);
  });

  it('carries the API name on the error', () => {
    const error = new UnsupportedNodeApiError('fs');
    expect(error.api).toBe('fs');
    expect(error.name).toBe('UnsupportedNodeApiError');
    expect(error).toBeInstanceOf(Error);
  });

  // Both ways Node use fails inside a Worker have to be recognised: the refused
  // require, and the bare global that simply does not exist.
  it.each(['process', 'Buffer', 'global', 'setImmediate', 'clearImmediate'])(
    'recognises a ReferenceError for %s',
    (name) => {
      let error: unknown;
      try {
        throw new ReferenceError(`${name} is not defined`);
      } catch (caught) {
        error = caught;
      }
      expect(nodeApiBehindError(error)).toBe(name);
    }
  );

  it('recognises the refused require, by name across a realm', () => {
    expect(nodeApiBehindError(new UnsupportedNodeApiError('fs'))).toBe('fs');
    expect(nodeApiBehindError({ name: 'UnsupportedNodeApiError', api: 'os' })).toBe('os');
  });

  // Node idioms on what a Worker does have: the only symptom is a TypeError.
  it.each([
    ['setTimeout(...).unref is not a function', 'timer.unref'],
    ['timer.ref is not a function', 'timer.unref'],
    ['t.hasRef is not a function', 'timer.unref'],
    ['crypto.createHash is not a function', 'crypto'],
    ['crypto.randomBytes is not a function', 'crypto'],
  ])('recognises the TypeError %s', (message, api) => {
    expect(nodeApiBehindError(new TypeError(message))).toBe(api);
  });

  // The policy's refusal of `eval` and `new Function`, in the words the doc's table uses.
  it('recognises a refused eval', () => {
    expect(nodeApiBehindError(new EvalError('Evaluating a string as JavaScript violates'))).toBe('eval');
    expect(unsupportedNodeApiMessage('eval')).toContain('eval or new Function');
    expect(isKnownNodeApi('eval')).toBe(true);
  });

  // A blocked `fetch` throws a bare "Failed to fetch", usually swallowed. Chromium's line
  // is the only thing left to say why the extension does nothing. The lines are verbatim.
  it.each([
    ["Connecting to 'https://x/' violates the following Content Security Policy directive: \"connect-src 'none'\". The action has been blocked.", 'network'],
    ["Fetch API cannot load https://x/. Refused to connect because it violates the document's Content Security Policy.", 'network'],
    ["Loading the font 'https://x/' violates the following Content Security Policy directive: \"font-src 'none'\".", 'network'],
    ["Loading the image 'https://x/' violates the following Content Security Policy directive: \"img-src 'none'\".", 'network'],
    ["Loading the script 'https://x/' violates the following Content Security Policy directive: \"script-src 'self'\".", 'remote-code'],
    ["Creating a worker from 'blob:x' violates the following Content Security Policy directive: \"worker-src 'none'\".", 'remote-code'],
  ])('reads a refusal in %s', (line, kind) => {
    expect(refusalInConsoleLine(line)).toBe(kind);
    expect(unsupportedNodeApiMessage(kind).length).toBeLessThanOrEqual(240);
    expect(isKnownNodeApi(kind)).toBe(true);
  });

  // Ordinary logging is not a refusal, or every extension would get a card.
  it.each(['Hello', 'Content Security Policy is on', 'connect-src is a directive', ''])('leaves %j alone', (line) => {
    expect(refusalInConsoleLine(line)).toBeNull();
  });

  // An extension's own bug must not be blamed on the runtime change: the user would
  // be told to update an extension that is failing for a different reason.
  it.each([
    [new ReferenceError('myHelper is not defined')],
    [new TypeError('process is not defined')],
    [new Error('boom')],
    ['a string'],
    [null],
    [undefined],
    [{ name: 'ReferenceError' }],
    [{ name: 'UnsupportedNodeApiError' }],
  ])('leaves %s alone', (error) => {
    expect(nodeApiBehindError(error)).toBeNull();
  });
});
