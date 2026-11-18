import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { PARAMETER_ROOT } from "./parameters.js";

export const CLAIM_CODE_BYTES = 24;
export const DEFAULT_CLAIM_TTL_MINUTES = 15;
export const MAX_CLAIM_TTL_MINUTES = 24 * 60;

export const adminClaimParameter = (platform: string) =>
  `${PARAMETER_ROOT}/admin-claim/${platform}`;

const claimSchema = z.object({
  bot: z.string(),
  hash: z.string().length(64),
  expiresAt: z.iso.datetime(),
});
export type AdminClaim = z.infer<typeof claimSchema>;

/** A URL-safe code that is also a valid Telegram deep-link payload (A-Z a-z 0-9 _ -). */
export const generateClaimCode = () => randomBytes(CLAIM_CODE_BYTES).toString("base64url");

export const hashClaimCode = (code: string) => createHash("sha256").update(code).digest("hex");

export const encodeClaim = (bot: string, code: string, expiresAt: Date) =>
  JSON.stringify({ bot, hash: hashClaimCode(code), expiresAt: expiresAt.toISOString() });

export function decodeClaim(value: string | undefined): AdminClaim | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = claimSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {}
  return undefined;
}
