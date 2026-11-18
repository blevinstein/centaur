import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

export interface OidcVerifier {
  verify(token: string): Promise<{ repository: string }>;
}

export interface GitHubOidcOptions {
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
      const { repository, repository_owner: tokenOwner } = payload;
      if (
        typeof repository !== "string" ||
        typeof tokenOwner !== "string" ||
        tokenOwner.toLowerCase() !== owner.toLowerCase() ||
        repository.split("/")[0]?.toLowerCase() !== owner.toLowerCase()
      ) {
        throw new Error(`OIDC token is not from a repository owned by ${owner}`);
      }
      return { repository };
    },
  };
}
