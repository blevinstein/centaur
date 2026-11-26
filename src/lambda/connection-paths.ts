import { PLATFORMS, type Platform } from "../config/index.js";
import type { AccessKind } from "./access-entries.js";
import { CHATS_PREFIX, PARAMETER_ROOT } from "./parameters.js";

export const BOTS_ROOT = `${PARAMETER_ROOT}/bots`;

export const WEBHOOK_SECRET_KEY: Record<Platform, string> = {
  telegram: "webhook-secret",
  slack: "signing-secret",
};

const APPROVED_DIRECTORY: Record<AccessKind, string> = {
  chat: "approved-chats",
  user: "approved-users",
};

export const botPath = (bot: string) => `${BOTS_ROOT}/${bot}`;
export const repoParameter = (bot: string) => `${botPath(bot)}/repo`;

/** The base path of a bot's connection on one platform; every per-connection key hangs off it. */
export const connectionPath = (bot: string, platform: Platform) =>
  `${botPath(bot)}/platforms/${platform}`;
export const connectionParameter = (bot: string, platform: Platform, key: string) =>
  `${connectionPath(bot, platform)}/${key}`;

/** Destinations are scoped to one platform: `chats/<platform>/<name>`. */
export const scopedChatPrefix = (platform: Platform) => `${CHATS_PREFIX}/${platform}`;
export const scopedChatParameter = (platform: Platform, name: string) =>
  `${scopedChatPrefix(platform)}/${name}`;

export const tokenParameter = (bot: string, platform: Platform) =>
  connectionParameter(bot, platform, "token");
export const webhookSecretParameter = (bot: string, platform: Platform) =>
  connectionParameter(bot, platform, WEBHOOK_SECRET_KEY[platform]);

export const approvedPrefix = (bot: string, platform: Platform, kind: AccessKind) =>
  connectionParameter(bot, platform, APPROVED_DIRECTORY[kind]);
export const approvedParameter = (bot: string, platform: Platform, kind: AccessKind, id: string) =>
  `${approvedPrefix(bot, platform, kind)}/${id}`;
export const blockedPrefix = (bot: string, platform: Platform, kind: AccessKind) =>
  connectionParameter(bot, platform, `blocked/${kind}`);
export const blockedParameter = (bot: string, platform: Platform, kind: AccessKind, id: string) =>
  `${blockedPrefix(bot, platform, kind)}/${id}`;

/** Users the admin authorizes to decide some requests; one entry per user ID. */
export const approversPrefix = (bot: string, platform: Platform) =>
  connectionParameter(bot, platform, "approvers");
export const approverParameter = (bot: string, platform: Platform, userId: string) =>
  `${approversPrefix(bot, platform)}/${userId}`;

export interface ParsedBotParameter {
  bot: string;
  /** Set for `repo` (bot level) and for the direct keys of a connection. */
  key?: string;
  platform?: Platform;
}

/** Inverse of the helpers above: which bot, connection and key a parameter name belongs to. */
export function parseBotParameter(name: string): ParsedBotParameter | undefined {
  if (!name.startsWith(`${BOTS_ROOT}/`)) return undefined;
  const [bot, ...rest] = name.slice(BOTS_ROOT.length + 1).split("/");
  if (!bot) return undefined;
  if (rest.length === 1 && rest[0] === "repo") return { bot, key: "repo" };
  const platform = PLATFORMS.find((candidate) => candidate === rest[1]);
  if (rest.length === 3 && rest[0] === "platforms" && platform && rest[2]) {
    return { bot, platform, key: rest[2] };
  }
  return { bot };
}

/** `bots/<bot>/mcp-approvals/<name>/<fingerprint>`; presence means the definition is approved. */
export const mcpApprovalsPrefix = (bot: string) => `${botPath(bot)}/mcp-approvals/`;
export const mcpApprovalParameter = (bot: string, name: string, fingerprint: string) =>
  `${mcpApprovalsPrefix(bot)}${name}/${fingerprint}`;

/** The stored value of an approval: when it was decided and by whom. */
export const mcpApprovalRecord = (approver: string) =>
  JSON.stringify({ at: new Date().toISOString(), approver });

/** Splits an approval subject `<name>:<fingerprint>` at its last colon. */
export const parseMcpApprovalKey = (subjectId: string) => {
  const split = subjectId.lastIndexOf(":");
  return { name: subjectId.slice(0, split), fingerprint: subjectId.slice(split + 1) };
};
