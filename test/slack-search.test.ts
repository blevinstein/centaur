import { describe, expect, it } from "vitest";
import { createSlackSearchApi, scopedQuery } from "../src/lambda/slack-search.js";
import { PARAMS, sentBody } from "./helpers/slack-search-fixtures.js";

describe("scopedQuery", () => {
  it.each([
    ["tomato blight", "in:<#C0123> tomato blight"],
    ["tomato in:C9999 blight", "in:<#C0123> tomato blight"],
    ["IN:<#C9999> tomato", "in:<#C0123> tomato"],
    ["-in:<#C9999|ops> tomato", "in:<#C0123> tomato"],
    ["(in:C9999) tomato", "in:<#C0123> ( ) tomato"],
    ["plain:thing main:x", "in:<#C0123> plain:thing main:x"],
    ["in:C9999", "in:<#C0123>"],
  ])("turns %j into %j", (query, expected) => {
    expect(scopedQuery(query, "C0123")).toBe(expected);
  });
});

describe("the Slack search API", () => {
  it("sends the channel-scoped query with the context channel", async () => {
    expect(await sentBody("tomato in:C9999")).toMatchObject({
      query: "in:<#C0123> tomato",
      context_channel_id: "C0123",
      channel_types: ["public_channel"],
    });
  });

  it("maps HTTP 429 to a rate limit carrying Retry-After", async () => {
    const fetchImpl = async () =>
      new Response("", { status: 429, headers: { "retry-after": "60" } });

    await expect(createSlackSearchApi(fetchImpl)(PARAMS)).resolves.toEqual({
      ok: false,
      error: "ratelimited",
      retryAfterSeconds: 60,
    });
  });
});
