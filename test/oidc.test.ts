import { describe, expect, it } from "vitest";
import { createGitHubOidcVerifier } from "../src/lambda/oidc.js";
import { createOidcSigner, OIDC_AUDIENCE, OIDC_OWNER } from "./helpers/poster-fixtures.js";

async function setup() {
  const signer = await createOidcSigner();
  const verifier = createGitHubOidcVerifier({
    owner: OIDC_OWNER,
    audience: OIDC_AUDIENCE,
    keys: signer.keys,
  });
  return { ...signer, verifier };
}

describe("GitHub OIDC verifier", () => {
  it("returns the repository claim of a valid token", async () => {
    const { verifier, sign } = await setup();

    await expect(verifier.verify(await sign())).resolves.toEqual({ repository: "octo/sprout" });
  });

  it("accepts the owner in a different case", async () => {
    const { verifier, sign } = await setup();

    await expect(
      verifier.verify(await sign({ repository: "Octo/sprout", repository_owner: "Octo" })),
    ).resolves.toEqual({ repository: "Octo/sprout" });
  });

  it.each([
    ["another audience", { aud: "someone-else" }],
    ["another issuer", { iss: "https://evil.example.com" }],
    ["another owner", { repository: "mallory/sprout", repository_owner: "mallory" }],
    ["a repository outside the owner", { repository: "mallory/sprout" }],
    ["no repository claim", { repository: undefined }],
  ])("rejects a token with %s", async (_name, claims) => {
    const { verifier, sign } = await setup();

    await expect(verifier.verify(await sign(claims))).rejects.toThrow();
  });

  it("rejects a token signed with an unknown key", async () => {
    const { verifier, sign, wrongKey } = await setup();

    await expect(verifier.verify(await sign({}, wrongKey))).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { verifier, sign } = await setup();

    await expect(
      verifier.verify(await sign({}, undefined, { expiresIn: "-1m" })),
    ).rejects.toThrow();
  });

  it("rejects an unsigned token", async () => {
    const { verifier } = await setup();
    const unsigned = `${btoa('{"alg":"none"}')}.${btoa('{"repository":"octo/x","repository_owner":"octo"}')}.`;

    await expect(verifier.verify(unsigned)).rejects.toThrow();
  });
});
