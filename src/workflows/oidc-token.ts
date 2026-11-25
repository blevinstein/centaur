import { SafeError } from "./safe-error.js";

export function oidcTokenFetcher(env: NodeJS.ProcessEnv, audience: string) {
  return async () => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) throw new SafeError("GitHub OIDC is unavailable; grant `id-token: write`");
    const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    }).catch((error: { cause?: { code?: unknown } }) => {
      const code = error.cause?.code;
      throw new SafeError(
        `OIDC token request failed (${typeof code === "string" ? code : "network error"})`,
      );
    });
    if (!response.ok) throw new SafeError(`OIDC token request failed (${response.status})`);
    return ((await response.json()) as { value: string }).value;
  };
}
