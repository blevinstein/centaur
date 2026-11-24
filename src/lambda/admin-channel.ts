import type { Platform } from "../config/index.js";
import { adminParameter } from "./access-entries.js";
import type { MessageRef, Verdict } from "./access-request-store.js";
import type { ParameterStore } from "./parameters.js";

export const APPROVE_EMOJI = "👍";
export const DENY_EMOJI = "👎";

export interface DirectMessenger {
  openDM(userId: string): Promise<{
    channelId: string;
    post(message: { raw: string }): Promise<{ id: string }>;
  }>;
}

/**
 * How a bot reaches its admin on one platform: send the request as a direct message, and read
 * the admin's answer from a reaction on it. `commands` says whether `/approve` and `/deny`
 * arrive as slash commands on this platform.
 */
export interface AdminChannel {
  readonly platform: Platform;
  readonly commands: boolean;
  notify(messenger: DirectMessenger, userId: string, text: string): Promise<MessageRef>;
  verdictForReaction(rawEmoji: string): Verdict | undefined;
}

function chatAdminChannel(
  platform: Platform,
  options: { approve: string[]; deny: string[]; commands: boolean },
): AdminChannel {
  return {
    platform,
    commands: options.commands,
    async notify(messenger, userId, text) {
      const dm = await messenger.openDM(userId);
      return { channelId: dm.channelId, messageId: (await dm.post({ raw: text })).id };
    },
    verdictForReaction(rawEmoji) {
      const name = rawEmoji.split("::")[0] as string;
      if (options.approve.includes(name)) return "approve";
      if (options.deny.includes(name)) return "deny";
      return undefined;
    },
  };
}

export const telegramAdminChannel = chatAdminChannel("telegram", {
  approve: [APPROVE_EMOJI],
  deny: [DENY_EMOJI],
  commands: true,
});

export const slackAdminChannel = chatAdminChannel("slack", {
  approve: ["+1", "thumbsup"],
  deny: ["-1", "thumbsdown"],
  commands: false,
});

export const ADMIN_CHANNELS: Record<Platform, AdminChannel> = {
  telegram: telegramAdminChannel,
  slack: slackAdminChannel,
};

export const lookupAdminId = (params: ParameterStore, platform: Platform) =>
  params.get(adminParameter(platform));
