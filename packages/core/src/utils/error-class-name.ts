/**
 * The class of a thrown value — `SyntaxError`, `Error`, or for a non-Error
 * throw its type (`string`, `object`) — and nothing else.
 *
 * For a log line or an error about a failure whose MESSAGE may carry what it
 * was working on: V8's JSON.parse quotes the text it choked on (a decrypted
 * secret), and a keychain's refusal is the platform's own account of it. The
 * class is enough to tell failures apart and says nothing about the data.
 */
export const errorClassName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
