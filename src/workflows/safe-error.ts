/** An error whose message never carries chat content, IDs or tokens, so it may be shown to the agent. */
export class SafeError extends Error {}

/** The message of a `SafeError`, else only the error's class name, so unvetted messages stay out of job logs. */
export const safeDetail = (error: unknown) =>
  error instanceof SafeError ? error.message : (error as Error).constructor.name;
