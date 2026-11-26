export const REQUEST_TIMEOUT_MS = 10_000;

/** Aborts an outbound call that hangs, leaving the Lambda time to report the failure. */
export const requestTimeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
