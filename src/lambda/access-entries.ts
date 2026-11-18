import { z } from "zod";
import { botParameter, PARAMETER_ROOT } from "./parameters.js";

export const ACCESS_KINDS = ["chat", "user"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

const APPROVED_DIRECTORY: Record<AccessKind, string> = {
  chat: "approved-chats",
  user: "approved-users",
};

export const approvedPrefix = (bot: string, kind: AccessKind) =>
  botParameter(bot, APPROVED_DIRECTORY[kind]);
export const approvedParameter = (bot: string, kind: AccessKind, id: string) =>
  `${approvedPrefix(bot, kind)}/${id}`;
export const blockedPrefix = (bot: string, kind: AccessKind) =>
  botParameter(bot, `blocked/${kind}`);
export const blockedParameter = (bot: string, kind: AccessKind, id: string) =>
  `${blockedPrefix(bot, kind)}/${id}`;
export const adminParameter = (platform: string) => `${PARAMETER_ROOT}/admin/${platform}`;

export const subjectIdOf = (parameterName: string) =>
  parameterName.slice(parameterName.lastIndexOf("/") + 1);

const entrySchema = z.object({ name: z.string().optional(), at: z.string() });
export type AccessEntry = z.infer<typeof entrySchema>;

export const encodeEntry = (name: string | undefined, at = new Date()) =>
  JSON.stringify({ ...(name ? { name } : {}), at: at.toISOString() });

export function decodeEntry(value: string): AccessEntry {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {}
  return { at: "unknown" };
}
