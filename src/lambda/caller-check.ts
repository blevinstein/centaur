import type { OidcVerifier } from "./oidc.js";
import type { ReadableParameters } from "./parameters.js";
import { requireBound } from "./registry.js";

/** The operations whose token is optional while `REQUIRE_POSTER_TOKEN` is off; the others always take one. */
export const OPTIONAL_TOKEN_OPERATIONS: ReadonlySet<string> = new Set([
  "post",
  "unreact",
  "start-thread",
  "get-mcp-policy",
]);

export interface CallerClaim {
  token?: string | undefined;
  /** The bot the caller acts as; an operation with no bot only needs a valid token. */
  bot?: string | undefined;
}

export interface CallerCheckDeps {
  params: ReadableParameters;
  oidc: OidcVerifier;
  /** Without it a request carrying no token passes; a token that is present is always verified. */
  required: boolean;
}

/** Verifies a caller's OIDC token and, when the request names a bot, that the bot is bound to the token's repository. */
export function createCallerCheck({ params, oidc, required }: CallerCheckDeps) {
  return async ({ token, bot }: CallerClaim) => {
    if (token === undefined) {
      if (required) throw new Error("this operation requires a GitHub OIDC token");
      return;
    }
    if (bot === undefined) await oidc.verify(token);
    else await requireBound(params, oidc, token, bot);
  };
}

/** Reads `REQUIRE_POSTER_TOKEN`; anything but unset, empty, `true` or `false` fails the cold start rather than relaxing the check. */
export function readRequirePosterToken(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.REQUIRE_POSTER_TOKEN;
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`REQUIRE_POSTER_TOKEN must be "true" or "false", got "${raw}"`);
}
