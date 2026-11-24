import { JSONRepairError } from 'jsonrepair';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LLMJsonError, parseLLMJson } from '../../../../src/utils/llm-json';

/**
 * How parseLLMJson describes a repair failure it has no name for. The pinned
 * jsonrepair cannot produce these from any input, so the repair pass is
 * replaced here.
 *
 * What breaks if this file fails: a future jsonrepair that words a failure
 * differently — or a failure thrown by something other than jsonrepair — has
 * its message, and the model's answer it quotes, copied into the error every
 * caller logs.
 */

const SENTINEL = 'SENTINEL-REPAIR-2a8b';
const h = vi.hoisted(() => ({ repair: vi.fn() }));
vi.mock('jsonrepair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jsonrepair')>()),
  jsonrepair: h.repair,
}));

afterEach(() => h.repair.mockReset());

const failureOf = (raw: string): LLMJsonError => {
  try {
    parseLLMJson(raw);
  } catch (err) {
    return err as LLMJsonError;
  }
  throw new Error('expected parseLLMJson to throw');
};

describe('an unnamed repair failure', () => {
  it('is named by the error class and position when jsonrepair words it a new way', () => {
    h.repair.mockImplementation(() => { throw new JSONRepairError(`Brand new complaint about "${SENTINEL}"`, 7); });
    const err = failureOf(`{"a": ${SENTINEL}`);
    expect(err.code).toBe('unrepairable');
    expect(err.message).toContain('(JSONRepairError at position 7;');
    expect(err.message).not.toContain(SENTINEL);
  });

  it('is named by its class when it is not a jsonrepair error at all', () => {
    h.repair.mockImplementation(() => { throw new TypeError(`cannot read ${SENTINEL}`); });
    const err = failureOf(`{"a": ${SENTINEL}`);
    expect(err.message).toContain('(TypeError;');
    expect(err.message).not.toContain(SENTINEL);
  });

  // jsonrepair handing back a JSON string for something that began as an
  // object: still not an answer, and still described without its text.
  it('rejects a repair that returns a bare string', () => {
    h.repair.mockImplementation(() => JSON.stringify(SENTINEL));
    const err = failureOf(`{"a": ${SENTINEL}`);
    expect(err.message).toContain('(model answered in prose, not JSON;');
    expect(err.message).not.toContain(SENTINEL);
  });
});
