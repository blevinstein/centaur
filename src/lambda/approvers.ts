import type { Platform } from "../config/index.js";
import { type AccessEntry, parseEntry, subjectIdOf } from "./access-entries.js";
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

/** The alphabet of a platform's user IDs; an ID is checked against it before it names a parameter. */
export const USER_ID_PATTERNS: Record<Platform, RegExp> = {
  telegram: /^\d{1,15}$/,
  slack: /^[UW][A-Z0-9]{1,20}$/,
};

export const isUserId = (platform: Platform, userId: string) =>
  USER_ID_PATTERNS[platform].test(userId);

/** Reads the set uncached, so a removal applies to the next decision. Malformed entries are skipped. */
export async function loadApproverEntries(
  params: Pick<ParameterStore, "getByPath">,
  bot: string,
  platform: Platform,
): Promise<Map<string, AccessEntry>> {
  const stored = await params.getByPath(approversPrefix(bot, platform));
  const entries = Object.entries(stored).flatMap(([name, value]) => {
    const entry = parseEntry(value);
    return entry ? [[subjectIdOf(name), entry] as const] : [];
  });
  return new Map(entries);
}

export async function loadApprovers(
  params: Pick<ParameterStore, "getByPath">,
  bot: string,
  platform: Platform,
): Promise<Set<string>> {
  return new Set((await loadApproverEntries(params, bot, platform)).keys());
}

/** The admin, or a member of the set; with no admin on the platform the set is inert. */
export const isMember = ({ admin, approvers, userId }: DeciderRoles) =>
  Boolean(admin) && (userId === admin || approvers.has(userId));

export const mayDecide = ({ kind, ...roles }: DeciderRoles & { kind: string }) =>
  isMember(roles) && (roles.userId === roles.admin || APPROVER_KINDS.includes(kind));

/**
 * Who is sent a request of `kind`: the admin first, then, for a kind an approver may decide, the
 * set in sorted order without the admin, at most MAX_APPROVERS of them.
 */
export async function recipientsFor(
  params: Pick<ParameterStore, "getByPath">,
  { name, platform }: { name: string; platform: Platform },
  kind: string,
  admin: string,
): Promise<string[]> {
  if (!APPROVER_KINDS.includes(kind)) return [admin];
  const approvers = [...(await loadApprovers(params, name, platform))]
    .filter((userId) => userId !== admin)
    .sort();
  return [admin, ...approvers.slice(0, MAX_APPROVERS)];
}
