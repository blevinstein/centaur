import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const NUMERIC_ID = /^\d+$/;

export interface OidcVerifier {
  verify(token: string): Promise<{ repository: string }>;
}

export interface GitHubOidcOptions {
  /** The owner's login, or its numeric id, which a rename cannot change. */
  owner: string;
  audience: string;
  keys?: JWTVerifyGetKey;
}

export function createGitHubOidcVerifier({
  owner,
  audience,
  keys = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`)),
}: GitHubOidcOptions): OidcVerifier {
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, {
        issuer: GITHUB_OIDC_ISSUER,
        audience,
        algorithms: ["RS256"],
      });
      const {
        repository,
        repository_owner: tokenOwner,
        repository_owner_id: tokenOwnerId,
      } = payload;
      if (typeof repository !== "string") throw new Error("OIDC token has no repository claim");
      const ownedByOwner = NUMERIC_ID.test(owner)
        ? String(tokenOwnerId) === owner
        : [tokenOwner, repository.split("/")[0]].every(
            (name) => typeof name === "string" && name.toLowerCase() === owner.toLowerCase(),
          );
      if (!ownedByOwner) throw new Error(`OIDC token is not from a repository owned by ${owner}`);
      return { repository };
    },
  };
}
