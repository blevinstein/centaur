import type { AccessDecisions } from "./access-decisions.js";
import { COMMAND_VERDICTS } from "./access-decisions.js";
import type { AdminChannel } from "./admin-channel.js";
import type { BotChat } from "./chat.js";

export function registerAdminHandlers(
  chat: Pick<BotChat, "onReaction" | "onSlashCommand">,
  channel: AdminChannel,
  decisions: AccessDecisions,
): void {
  chat.onReaction((event) => decisions.fromReaction(event));
  if (!channel.commands) return;
  chat.onSlashCommand(Object.keys(COMMAND_VERDICTS), async (event) => {
    const reply = await decisions.fromCommand({
      ...event,
      isDM: event.adapter.isDM?.(event.channel.id) ?? false,
    });
    if (reply) await event.channel.post(reply);
  });
}
