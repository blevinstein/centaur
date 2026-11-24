import type { Platform } from "../config/index.js";
import { parseEntry, subjectIdOf } from "./access-entries.js";
import type { RequestKind } from "./access-request-store.js";
import { approversPrefix } from "./connection-paths.js";
import type { ParameterStore } from "./parameters.js";

export const MAX_APPROVERS = 10;

/** The request kinds an approver may decide; the admin decides every kind. */
export const APPROVER_KINDS: readonly string[] = ["mcp"] satisfies RequestKind[];

export interface DeciderRoles {
  admin: string | undefined;
  approvers: ReadonlySet<string>;
  userId: string;
}

/** Reads the set uncached, so a removal applies to the next decision. Malformed entries are skipped. */
export async function loadApprovers(
  params: Pick<ParameterStore, "getByPath">,
  bot: string,
  platform: Platform,
): Promise<Set<string>> {
  const entries = await params.getByPath(approversPrefix(bot, platform));
  return new Set(
    Object.entries(entries)
      .filter(([, value]) => parseEntry(value))
      .map(([name]) => subjectIdOf(name)),
  );
}

/** The admin, or a member of the set; with no admin on the platform the set is inert. */
export const isMember = ({ admin, approvers, userId }: DeciderRoles) =>
  Boolean(admin) && (userId === admin || approvers.has(userId));

export const mayDecide = ({ kind, ...roles }: DeciderRoles & { kind: string }) =>
  isMember(roles) && (roles.userId === roles.admin || APPROVER_KINDS.includes(kind));
