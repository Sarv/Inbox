/**
 * The REAL log helpers from core, for a test that mocks `@sarvinbox/core`
 * with only the pieces it needs. Product code routes account ids, folder and
 * label names, paths and errors through these before they reach a log line,
 * so a mock without them fails at the first log line — and a stand-in would
 * hide what the line really says. Spread it first in the mock factory:
 *
 *   vi.mock('@sarvinbox/core', async () => ({
 *     ...(await import('../../../helpers/core-log-helpers')),
 *     createLogger: () => quietLogger,
 *   }));
 */
export * from '../../../../packages/core/src/utils/error-diagnostic';
export * from '../../../../packages/core/src/utils/log-labels';
export * from '../../../../packages/core/src/utils/log-paths';
