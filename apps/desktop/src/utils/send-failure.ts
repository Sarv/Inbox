/**
 * Log a failed email send and surface it to the user via an alert. Shared by
 * every compose surface (new compose, inline reply, inline forward) so the
 * message and logging stay consistent.
 */
export const reportSendFailure = (error: unknown): void => {
  console.error('Failed to send email:', error);
  // NEVER dereference the rejection value directly: an IPC `Promise.reject(null)`
  // made `(error as Error).message` throw a TypeError from inside this handler,
  // which escaped the compose catch and showed the user NO dialog at all — a send
  // that failed silently. Fall back to the stringified value, then a generic
  // reason, so there is always something on screen.
  const reason = (error as Error | null | undefined)?.message
    || (typeof error === 'string' ? error : '')
    || 'Unknown error';
  alert(`Failed to send email: ${reason}`);
};
