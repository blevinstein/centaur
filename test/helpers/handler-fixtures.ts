import { vi } from "vitest";
import { FakeParameterStore } from "./fake-parameter-store.js";

export const HANDLER_ENV = {
  STATE_TABLE_NAME: "state-table",
  SESSION_BUCKET_NAME: "session-bucket",
  GITHUB_OWNER: "octo",
  OIDC_AUDIENCE: "centaur",
};

export function handlerParams(entries: Record<string, string>) {
  const params = new FakeParameterStore();
  for (const [name, value] of Object.entries(entries))
    params.entries.set(name, { value, secure: false });
  return params;
}

export async function importFreshHandler() {
  vi.resetModules();
  return (await import("../../src/lambda/handler.js")).handler;
}
