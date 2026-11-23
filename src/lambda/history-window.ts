import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_HISTORY_MAX_MESSAGES = 100;
export const DEFAULT_HISTORY_TTL_DAYS = 7;
/** The state adapter reads a whole list on every append, so cost per message grows with this. */
export const HISTORY_MAX_MESSAGES_LIMIT = 5000;
export const HISTORY_TTL_DAYS_LIMIT = 365;

export interface HistoryWindow {
  maxMessages: number;
  ttlMs: number;
}

export const DEFAULT_HISTORY_WINDOW: HistoryWindow = {
  maxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
  ttlMs: DEFAULT_HISTORY_TTL_DAYS * DAY_MS,
};

const setting = (name: string, fallback: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === "" ? fallback : Number(raw)))
    .pipe(
      z
        .number({ error: `${name} must be a number` })
        .int(`${name} must be an integer`)
        .min(1, `${name} must be at least 1`)
        .max(max, `${name} must be at most ${max}`),
    );

const envSchema = z.object({
  HISTORY_MAX_MESSAGES: setting(
    "HISTORY_MAX_MESSAGES",
    DEFAULT_HISTORY_MAX_MESSAGES,
    HISTORY_MAX_MESSAGES_LIMIT,
  ),
  HISTORY_TTL_DAYS: setting("HISTORY_TTL_DAYS", DEFAULT_HISTORY_TTL_DAYS, HISTORY_TTL_DAYS_LIMIT),
});

/** The stored-history window for the chat and thread message lists, from the Lambda environment. */
export function readHistoryWindow(env: NodeJS.ProcessEnv = process.env): HistoryWindow {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid history window: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return {
    maxMessages: parsed.data.HISTORY_MAX_MESSAGES,
    ttlMs: parsed.data.HISTORY_TTL_DAYS * DAY_MS,
  };
}
