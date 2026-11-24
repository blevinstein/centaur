import type { SlashCommandEvent } from "chat";
import type { AccessDecisions } from "./access-decisions.js";
import { COMMAND_VERDICTS } from "./access-decisions.js";
import type { AdminChannel } from "./admin-channel.js";
import type { AdminClaimer } from "./admin-claims.js";
import { CLAIM_COMMANDS } from "./admin-claims.js";
import {
  APPROVER_COMMANDS,
  type ApproverCommand,
  readApproverCommand,
  telegramReplyTo,
} from "./approver-commands.js";
import type { BotChat } from "./chat.js";

export function registerAdminHandlers(
  chat: Pick<BotChat, "onReaction" | "onSlashCommand" | "processMessage">,
  channel: AdminChannel,
  decisions: AccessDecisions,
  claimAdmin: AdminClaimer,
  approverCommand: ApproverCommand,
): void {
  chat.onReaction((event) => decisions.fromReaction(event));
  if (!channel.commands) return;
  const isDM = (event: SlashCommandEvent) => event.adapter.isDM?.(event.channel.id) ?? false;
  const replyOrProcess = async (event: SlashCommandEvent, reply: string | undefined) => {
    if (reply) {
      await event.channel.post(reply);
      return;
    }
    await chat.processMessage(
      event.adapter,
      event.channel.id,
      event.adapter.parseMessage(event.raw),
    );
  };
  chat.onSlashCommand(Object.keys(COMMAND_VERDICTS), async (event) => {
    const reply = await decisions.fromCommand({ ...event, isDM: isDM(event) });
    if (reply) await event.channel.post(reply);
  });
  chat.onSlashCommand(CLAIM_COMMANDS, async (event) => {
    const code = event.text.trim().split(/\s+/)[0];
    await replyOrProcess(
      event,
      code ? await claimAdmin({ userId: event.user.userId, isDM: isDM(event), code }) : undefined,
    );
  });
  chat.onSlashCommand(APPROVER_COMMANDS, async (event) => {
    const command = readApproverCommand(`approver ${event.text}`);
    await replyOrProcess(
      event,
      command
        ? await approverCommand({
            ...command,
            replyTo: telegramReplyTo(event.raw),
            userId: event.user.userId,
            name: event.user.fullName || event.user.userName,
            isDM: isDM(event),
            threadId: event.channel.id,
          })
        : undefined,
    );
  });
}
