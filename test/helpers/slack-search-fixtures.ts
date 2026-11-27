import { vi } from "vitest";
import { createSlackSearchApi } from "../../src/lambda/slack-search.js";

export const PARAMS = {
  botToken: "xoxb-token",
  actionToken: "action",
  query: "tomato blight",
  channelId: "C0123",
  limit: 5,
};

export const sentBody = async (query: string) => {
  const fetchImpl = vi.fn(async (..._args: unknown[]) => Response.json({ ok: true }));
  await createSlackSearchApi(fetchImpl as unknown as typeof fetch)({ ...PARAMS, query });
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string);
};
