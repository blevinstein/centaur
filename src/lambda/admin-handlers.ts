import type { AccessDecisions } from "./access-decisions.js";
import { COMMAND_VERDICTS } from "./access-decisions.js";
import type { AdminChannel } from "./admin-channel.js";
import type { AdminClaimer } from "./admin-claims.js";
import { CLAIM_COMMANDS } from "./admin-claims.js";
import type { BotChat } from "./chat.js";

export function registerAdminHandlers(
  chat: Pick<BotChat, "onReaction" | "onSlashCommand" | "processMessage">,
  channel: AdminChannel,
  decisions: AccessDecisions,
  claimAdmin: AdminClaimer,
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
  chat.onSlashCommand(CLAIM_COMMANDS, async (event) => {
    const code = event.text.trim().split(/\s+/)[0];
    const reply = code
      ? await claimAdmin({
          userId: event.user.userId,
          isDM: event.adapter.isDM?.(event.channel.id) ?? false,
          code,
        })
      : undefined;
    if (reply) {
      await event.channel.post(reply);
      return;
    }
    await chat.processMessage(
      event.adapter,
      event.channel.id,
      event.adapter.parseMessage(event.raw),
    );
  });
}
