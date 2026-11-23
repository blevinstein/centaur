import type { StateAdapter } from "chat";
import { describe, expect, it } from "vitest";
import { registerConfigText } from "./helpers/config-fixtures.js";
import { ORPHAN_PARAMETERS, posterSetup } from "./helpers/poster-fixtures.js";
import { CONNECT_FAILURE, strictStates } from "./helpers/strict-state.js";

const setup = async (options: Parameters<typeof posterSetup>[0] = {}, strict = strictStates()) => {
  return {
    strict,
    ...(await posterSetup({
      ...options,
      registryState: strict.inner(""),
      createState: strict.createState,
    })),
  };
};

const LINK = {
  operation: "link-pull-request",
  token: "jwt",
  bot: "garden",
  threadId: "telegram:-100500:77",
  pullRequest: 12,
} as const;

describe("poster state adapters are connected before direct use", () => {
  it("registers a bot through the registry adapter", async () => {
    const { poster, strict } = await setup({
      parameters: ORPHAN_PARAMETERS,
    });

    await expect(
      poster({ operation: "register", token: "jwt", config: registerConfigText() }),
    ).resolves.toEqual({ bot: "sprout", repo: "octo/sprout" });
    expect(strict.connects("")).toBe(1);
  });

  it("links and resolves a pull request, connecting the registry adapter once", async () => {
    const { poster, strict } = await setup({ repository: "octo/garden" });

    await expect(poster(LINK)).resolves.toEqual({ linked: true });
    await expect(
      poster({ operation: "resolve-pull-request", token: "jwt", pullRequest: 12 }),
    ).resolves.toMatchObject({ found: true });
    expect(strict.connects("")).toBe(1);
  });

  it("hands the chat a connected bot adapter, shared across requests", async () => {
    const { poster, chatFor, strict } = await setup();

    await poster({ operation: "post", bot: "garden", threadId: "telegram:-100500:77", text: "hi" });
    await poster({ operation: "post", bot: "garden", threadId: "telegram:-100500:77", text: "hi" });
    const botState = (chatFor.mock.calls as unknown[][])[0]?.[1] as StateAdapter;
    await botState.set("k", 1);
    await botState.connect();

    expect((chatFor.mock.calls as unknown[][])[1]?.[1]).toBe(botState);
    expect(await botState.get("k")).toBe(1);
    expect(strict.connects("bot:garden:")).toBe(1);
  });

  it("retries a failed bot adapter connect on the next request", async () => {
    const strict = strictStates({ failConnects: { "bot:garden:": 1 } });
    const { poster, chatFor } = await setup({}, strict);
    const post = () =>
      poster({ operation: "post", bot: "garden", threadId: "telegram:-100500:77", text: "hi" });

    await expect(post()).rejects.toThrow(CONNECT_FAILURE);
    await post();

    expect(strict.connects("bot:garden:")).toBe(2);
    expect(chatFor).toHaveBeenCalledOnce();
  });

  it("fails building the poster when the registry connect fails", async () => {
    const strict = strictStates({ failConnects: { "": 1 } });

    await expect(
      posterSetup({ registryState: strict.inner(""), createState: strict.createState }),
    ).rejects.toThrow(CONNECT_FAILURE);
  });
});
