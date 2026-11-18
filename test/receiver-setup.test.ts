import { describe, expect, it, vi } from "vitest";
import { createAccessResolver } from "../src/lambda/access.js";
import { createGitHubDispatcher } from "../src/lambda/github.js";
import { loadBots } from "../src/lambda/registry.js";
import {
  fakeParameterStore,
  GARDEN_BOT,
  registryStateWith,
  SLACK_BOT,
} from "./helpers/receiver-fixtures.js";

describe("loadBots", () => {
  it("returns bound, fully configured bots using the platform's secret parameter", async () => {
    const bots = await loadBots(fakeParameterStore());

    expect(bots).toEqual(expect.arrayContaining([GARDEN_BOT, SLACK_BOT]));
    expect(bots.map((bot) => bot.name).sort()).toEqual(["garden", "notes"]);
  });
});

describe("createAccessResolver", () => {
  it("maps registered user and destination names to platform IDs", async () => {
    const state = await registryStateWith({
      garden: { allow: ["maintainer", "spouse", "nobody"], destination: "household" },
    });

    const access = await createAccessResolver(GARDEN_BOT, fakeParameterStore(), state)();

    expect(access.userIds).toEqual(new Set(["1001", "1002"]));
    expect(access.chatIds).toEqual(new Set(["-100500"]));
  });

  it("allows nobody when the bot has no registry entry", async () => {
    const access = await createAccessResolver(
      GARDEN_BOT,
      fakeParameterStore(),
      await registryStateWith({}),
    )();

    expect(access.userIds.size + access.chatIds.size).toBe(0);
  });
});

describe("createGitHubDispatcher", () => {
  it("posts a repository_dispatch with the token and payload", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await createGitHubDispatcher("ghp_x", fetchImpl).dispatch("octo/garden", "centaur-message", {
      thread_id: "t",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/octo/garden/dispatches");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_x");
    expect(JSON.parse(init.body as string)).toEqual({
      event_type: "centaur-message",
      client_payload: { thread_id: "t" },
    });
  });

  it("fails with the status code only when GitHub rejects the dispatch", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret detail", { status: 404 }));

    await expect(
      createGitHubDispatcher("ghp_x", fetchImpl).dispatch("octo/garden", "e", {}),
    ).rejects.toThrow("HTTP 404");
  });
});
