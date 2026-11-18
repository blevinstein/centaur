import { timingSafeEqual } from "node:crypto";
import type { Logger, StateAdapter } from "chat";
import { adminParameter } from "./access-entries.js";
import { adminClaimParameter, decodeClaim, hashClaimCode } from "./admin-claim-record.js";
import type { ParameterStore } from "./parameters.js";
import type { Bot } from "./registry.js";

export const CLAIMED_TEXT = "You're now the admin for this bot's platform.";
export const INVALID_CODE_TEXT = "That code isn't valid.";
export const MAX_CLAIM_FAILURES = 5;
export const CLAIM_COMMANDS = ["/start", "/claim"];
export const CLAIM_MESSAGE = /^claim\s+(\S+)\s*$/i;

const failuresKey = (hash: string) => `admin-claim-failures:${hash}`;

const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface AdminClaimerDeps {
  bot: Bot;
  params: ParameterStore;
  state: StateAdapter;
  invalidateAccess: () => void;
  logger: Pick<Logger, "info" | "warn">;
}

export type AdminClaimer = (attempt: {
  userId: string;
  isDM: boolean;
  code: string;
}) => Promise<string | undefined>;

/**
 * Resolves a claim attempt to the reply for the sender, or undefined when the message is not a
 * live claim for this bot (no pending claim, expired, another bot's, or outside a DM) so that it
 * is handled as an ordinary message.
 */
export function createAdminClaimer({
  bot,
  params,
  state,
  invalidateAccess,
  logger,
}: AdminClaimerDeps): AdminClaimer {
  const where = { bot: bot.name, platform: bot.platform };
  const claimName = adminClaimParameter(bot.platform);

  return async ({ userId, isDM, code }) => {
    if (!isDM) return undefined;
    const claim = decodeClaim(await params.get(claimName));
    if (!claim || claim.bot !== bot.name) return undefined;
    const remainingMs = Date.parse(claim.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      await params.delete(claimName);
      return undefined;
    }

    if (sameHash(claim.hash, hashClaimCode(code))) {
      await params.put(adminParameter(bot.platform), userId);
      await params.delete(claimName);
      await state.delete(failuresKey(claim.hash));
      invalidateAccess();
      logger.info("admin claimed", { ...where, userId });
      return CLAIMED_TEXT;
    }

    const failures = ((await state.get<number>(failuresKey(claim.hash))) ?? 0) + 1;
    logger.warn("admin claim attempt with a wrong code", { ...where, userId, failures });
    if (failures >= MAX_CLAIM_FAILURES) {
      await params.delete(claimName);
      await state.delete(failuresKey(claim.hash));
      logger.warn("admin claim invalidated after repeated failures", where);
    } else {
      await state.set(failuresKey(claim.hash), failures, remainingMs);
    }
    return INVALID_CODE_TEXT;
  };
}
