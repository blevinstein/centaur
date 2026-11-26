import type { Logger } from "chat";
import type { OidcVerifier } from "./oidc.js";
import type { ReadableParameters } from "./parameters.js";
import { requireBound } from "./registry.js";

export interface CallerClaim {
  operation: string;
  token?: string | undefined;
  /** The bot the caller acts as; an operation with no bot only needs a valid token. */
  bot?: string | undefined;
  /** The bot may have no repository yet, as at `register`; a bot bound elsewhere still fails. */
  allowUnbound?: boolean;
}

export interface CallerCheckDeps {
  params: ReadableParameters;
  oidc: OidcVerifier;
  /** Without it a request carrying no token passes; a token that is present is always verified. */
  required: boolean;
  logger: Pick<Logger, "warn">;
}

/** Verifies a caller's OIDC token and that the bot it names, if any, is bound to the token's repository. */
export function createCallerCheck({ params, oidc, required, logger }: CallerCheckDeps) {
  return async ({ operation, token, bot, allowUnbound }: CallerClaim) => {
    if (token === undefined) {
      if (required) throw new Error("this operation requires a GitHub OIDC token");
      logger.warn("poster call without a token", { operation, ...(bot ? { bot } : {}) });
      return;
    }
    if (bot === undefined) await oidc.verify(token);
    else await requireBound(params, oidc, token, bot, { allowUnbound: allowUnbound ?? false });
  };
}

/** Reads `REQUIRE_POSTER_TOKEN`; anything but unset, empty, `true` or `false` fails the cold start rather than relaxing the check. */
export function readRequirePosterToken(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.REQUIRE_POSTER_TOKEN;
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`REQUIRE_POSTER_TOKEN must be "true" or "false", got "${raw}"`);
}
