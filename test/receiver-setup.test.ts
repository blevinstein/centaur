import { describe, expect, it, vi } from "vitest";
import { createAccessResolver } from "../src/lambda/access.js";
import { createGitHubDispatcher } from "../src/lambda/github.js";
import { loadBots, readRespondTo } from "../src/lambda/registry.js";
import {
  fakeParameterStore,
  GARDEN_BOT,
  PARAMETERS,
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
  it.each([
    [
      "several chats",
      { chats: ["household", "workshop", "unknown"] },
      new Set(["-100500", "-100900"]),
    ],
    ["a single chat", { chats: ["workshop"] }, new Set(["-100900"])],
    ["a legacy destination", { destination: "household" }, new Set(["-100500"])],
    [
      "chats over a legacy destination",
      { chats: ["workshop"], destination: "household" },
      new Set(["-100900"]),
    ],
    ["no chats", {}, new Set()],
  ])(
    "maps registered user and chat names to platform IDs for %s",
    async (_name, chats, chatIds) => {
      const state = await registryStateWith({
        garden: { allow: ["maintainer", "spouse", "nobody"], ...chats },
      });
      const params = fakeParameterStore({ ...PARAMETERS, "/centaur/chats/workshop": "-100900" });

      const access = await createAccessResolver(GARDEN_BOT, params, state)();

      expect(access.userIds).toEqual(new Set(["1001", "1002"]));
      expect(access.chatIds).toEqual(chatIds);
    },
  );

  it.each([
    ["an entry written before respond_to existed", { allow: ["maintainer"] }, "mention"],
    ["an entry that names respond_to", { allow: ["maintainer"], respond_to: "all" }, "all"],
    ["no entry", undefined, "mention"],
  ])("reads respond_to from %s", async (_name, entry, expected) => {
    const state = await registryStateWith(entry ? { garden: entry } : {});

    await expect(readRespondTo(state, "garden")).resolves.toBe(expected);
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
