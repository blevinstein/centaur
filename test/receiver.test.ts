import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it } from "vitest";
import { createReceiver } from "../src/lambda/receiver.js";
import { fakeDispatcher, fakeLogger, fakeParameterStore } from "./helpers/receiver-fixtures.js";

const receiver = () =>
  createReceiver({
    params: fakeParameterStore(),
    stateFor: () => createMemoryState(),
    dispatcher: fakeDispatcher(),
    logger: fakeLogger(),
  });

const post = (path: string, init: RequestInit = {}) =>
  new Request(`https://example.test${path}`, { method: "POST", body: "{}", ...init });

describe("receiver routing", () => {
  it.each([
    ["an unknown bot", post("/telegram/ghost")],
    ["a bot on the wrong platform", post("/slack/garden")],
    ["a bot without a repo binding", post("/telegram/unbound")],
    ["a bot with missing secrets", post("/slack/partial")],
    ["an unrelated path", post("/")],
    ["a GET", new Request("https://example.test/telegram/garden")],
  ])("answers 404 for %s", async (_name, request) => {
    expect((await (await receiver())(request)).status).toBe(404);
  });

  it.each([["/telegram/garden"], ["/slack/notes"]])(
    "routes %s to its adapter, which rejects unsigned requests",
    async (path) => {
      expect((await (await receiver())(post(path))).status).toBe(401);
    },
  );
});
