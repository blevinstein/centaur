import type { JWTPayload } from "jose";
import { createGitHubOidcVerifier } from "../../src/lambda/oidc.js";
import type { PosterRequest } from "../../src/lambda/poster.js";
import {
  createOidcSigner,
  GARDEN_REPOSITORY,
  HOUSEHOLD_CHAT_ID,
  OIDC_AUDIENCE,
  OIDC_OWNER,
  posterSetup,
  TOPIC_ID,
} from "./poster-fixtures.js";

const GARDEN_THREAD = `telegram:${HOUSEHOLD_CHAT_ID}:${TOPIC_ID}`;

export const BOT_OPERATIONS = {
  post: { operation: "post", bot: "garden", threadId: GARDEN_THREAD, text: "hi" },
  unreact: { operation: "unreact", bot: "garden", threadId: GARDEN_THREAD, messageIds: ["1"] },
  "start-thread": {
    operation: "start-thread",
    bot: "garden",
    destination: "household",
    text: "hi",
  },
} satisfies Record<string, PosterRequest>;

export const CALLER_CHECKED_OPERATIONS = {
  ...BOT_OPERATIONS,
  "get-mcp-policy": { operation: "get-mcp-policy" },
} satisfies Record<string, PosterRequest>;

/** A poster over the real verifier; `sign` mints tokens for it. */
export async function verifyingPosterSetup(requirePosterToken: boolean) {
  const signer = await createOidcSigner();
  const oidc = createGitHubOidcVerifier({
    owner: OIDC_OWNER,
    audience: OIDC_AUDIENCE,
    keys: signer.keys,
  });
  const setup = await posterSetup({ oidc, requirePosterToken });
  const signGarden = (
    claims: JWTPayload = {},
    key?: Parameters<typeof signer.sign>[1],
    options?: { expiresIn?: string },
  ) => signer.sign({ repository: GARDEN_REPOSITORY, ...claims }, key, options);
  return { ...setup, ...signer, signGarden };
}
