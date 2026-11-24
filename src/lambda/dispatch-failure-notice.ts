import type { Logger, StateAdapter } from "chat";
import { z } from "zod";
import { type AdminChannel, type DirectMessenger, lookupAdminId } from "./admin-channel.js";
import { DispatchError, type RepositoryDispatcher } from "./github.js";
import { setting } from "./history-window.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

const MINUTE_MS = 60 * 1000;

export const DEFAULT_FAILURE_NOTICE_MINUTES = 15;
export const FAILURE_NOTICE_MINUTES_LIMIT = 1440;

const envSchema = z.object({
  DISPATCH_FAILURE_NOTICE_MINUTES: setting(
    "DISPATCH_FAILURE_NOTICE_MINUTES",
    DEFAULT_FAILURE_NOTICE_MINUTES,
    FAILURE_NOTICE_MINUTES_LIMIT,
    0,
  ),
});

/** The minimum time between dispatch failure notices per bot, from the Lambda environment; 0 turns the notice off. */
export function readFailureNoticeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid dispatch failure notice interval: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data.DISPATCH_FAILURE_NOTICE_MINUTES * MINUTE_MS;
}

const NOTICE_KEY = "dispatch-failure-notice";

const ACCESS_HINT =
  "The GitHub token may lack access to that repository (a fine-grained token needs the repository added with Contents read/write).";
const HINTS: Record<number, string> = { 401: ACCESS_HINT, 403: ACCESS_HINT, 404: ACCESS_HINT };
const WORKFLOW_HINT = "Check the repository's centaur workflow.";
const LOGS_HINT = "Look at the receiver logs.";

const hintFor = (status: number | undefined) =>
  status === undefined ? LOGS_HINT : (HINTS[status] ?? WORKFLOW_HINT);

export interface FailureNoticeDeps {
  bot: Bot;
  /** Minimum time between notices; 0 sends none. */
  intervalMs: number;
  params: ParameterStore;
  /** Per-bot state: the notice limit is per bot. */
  state: Pick<StateAdapter, "setIfNotExists">;
  channel: AdminChannel;
  messenger: DirectMessenger;
  logger: Pick<Logger, "warn">;
}

/**
 * Wraps a dispatcher so a failed dispatch sends the bot's admin a direct message (at most one per
 * bot per interval). The notice is best effort and the original error always propagates.
 */
export function withFailureNotice(
  dispatcher: RepositoryDispatcher,
  { bot, intervalMs, params, state, channel, messenger, logger }: FailureNoticeDeps,
): RepositoryDispatcher {
  const notifyAdmin = async (error: unknown) => {
    if (intervalMs === 0) return;
    const adminId = await lookupAdminId(params, bot.platform);
    if (!adminId) return;
    if (!(await state.setIfNotExists(NOTICE_KEY, true, intervalMs))) return;
    const status = error instanceof DispatchError ? error.status : undefined;
    await channel.notify(
      messenger,
      adminId,
      [
        "I couldn't start a turn: the dispatch to GitHub failed.",
        `Bot: ${bot.name}`,
        `Platform: ${bot.platform}`,
        `Repository: ${bot.repo}`,
        ...(status === undefined ? [] : [`HTTP status: ${status}`]),
        hintFor(status),
      ].join("\n"),
    );
  };

  return {
    async dispatch(repo, eventType, clientPayload) {
      try {
        await dispatcher.dispatch(repo, eventType, clientPayload);
      } catch (error) {
        try {
          await notifyAdmin(error);
        } catch {
          logger.warn("failed to notify admin of dispatch failure", {
            bot: bot.name,
            platform: bot.platform,
          });
        }
        throw error;
      }
    },
  };
}
