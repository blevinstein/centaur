import { createHash } from "node:crypto";
import {
  type Adapter,
  emoji,
  type Logger,
  type Message,
  type StateAdapter,
  type Thread,
} from "chat";
import type { Platform } from "../config/index.js";
import type { ThreadMetadata } from "./ownership.js";

/** Redeliveries the platform may make after the first attempt before the sender is told to resend. */
export const MAX_REDELIVERIES = 2;
const ATTEMPTS_TTL_MS = 60 * 60 * 1000;

export const GIVE_UP_TEXT = "Sorry, I couldn't start on that message. Please send it again.";

/** Thrown out of a message handler to make the receiver answer non-2xx, so the platform redelivers the message. */
export class RedeliveryRequested extends Error {
  constructor(options: ErrorOptions) {
    super("message handling failed; asking the platform to redeliver", options);
    this.name = "RedeliveryRequested";
  }
}

export interface RedeliveryDeps {
  /** The bot's state, the one the Chat SDK writes its dedupe keys to. */
  state: Pick<StateAdapter, "get" | "set" | "delete">;
  logger: Pick<Logger, "error" | "warn">;
}

type MessageHandler = (thread: Thread<ThreadMetadata>, message: Message) => Promise<void>;

/**
 * Wraps a message handler so a failure does not lose the message. The Chat SDK records its dedupe
 * key before the handler runs and the platform got a 200 for the webhook, so neither a platform
 * retry nor the sender could recover it. A failure instead releases the dedupe key and throws
 * `RedeliveryRequested`; after `MAX_REDELIVERIES` the sender is told to resend. A handler that
 * failed after a side effect repeats that effect when the platform redelivers.
 */
export function withRedelivery(
  handle: MessageHandler,
  { state, logger }: RedeliveryDeps,
): MessageHandler {
  return async (thread, message) => {
    try {
      await handle(thread, message);
    } catch (error) {
      const id = `${thread.adapter.name}:${message.id}`;
      const attemptsKey = `redelivery-attempts:${id}`;
      const attempts = (await state.get<number>(attemptsKey)) ?? 0;
      if (attempts >= MAX_REDELIVERIES) {
        logger.error("giving up on message after failed redeliveries", { id, error });
        await giveUp(thread, message, logger);
        return;
      }
      await state.set(attemptsKey, attempts + 1, ATTEMPTS_TTL_MS);
      await state.delete(`dedupe:${id}`);
      throw new RedeliveryRequested({ cause: error });
    }
  };
}

async function giveUp(
  thread: Thread<ThreadMetadata>,
  message: Message,
  logger: Pick<Logger, "warn">,
) {
  const results = await Promise.allSettled([
    thread.adapter.removeReaction(thread.id, message.id, emoji.eyes),
    thread.post(GIVE_UP_TEXT),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("failed to tell the sender that the message was dropped", {
        error: result.reason,
      });
    }
  }
}

interface WebhookBody {
  update_id?: number;
  event_id?: string;
}

/** The key each adapter writes to drop a redelivered webhook; the adapters keep it private. */
const WEBHOOK_MARKERS: Record<
  Platform,
  (adapter: Adapter, body: WebhookBody) => string | undefined
> = {
  telegram: ({ botUserId }, { update_id }) =>
    botUserId && update_id !== undefined
      ? `telegram:webhook-update:${createHash("sha256").update(botUserId).digest("hex")}:${update_id}`
      : undefined,
  slack: (_, { event_id }) => (event_id ? `slack:event-delivered:${event_id}` : undefined),
};

/** Releases the adapter's own record of a webhook, which would otherwise drop the platform's redelivery of it. */
export async function releaseWebhookMarker(
  platform: Platform,
  adapter: Adapter,
  state: Pick<StateAdapter, "delete">,
  delivery: Request,
) {
  const body = (await delivery.json().catch(() => ({}))) as WebhookBody;
  const key = WEBHOOK_MARKERS[platform](adapter, body);
  if (key) await state.delete(key);
}
