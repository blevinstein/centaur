import { describe, expect, it, vi } from "vitest";
import { readRegistryEntry } from "../src/lambda/registry.js";
import { registerConfigText } from "./helpers/config-fixtures.js";
import {
  FUNCTION_URL,
  ORPHAN_PARAMETERS,
  posterSetup,
  SPROUT_SLACK_PARAMETERS,
} from "./helpers/poster-fixtures.js";
import { connectionParameters, REGISTERED_ENTRY } from "./helpers/receiver-fixtures.js";

const register = (
  poster: Awaited<ReturnType<typeof posterSetup>>["poster"],
  config = registerConfigText(),
) => poster({ operation: "register", token: "jwt", config });

describe("register", () => {
  it("binds the bot to the OIDC repo, writes the registry entry and sets the Telegram webhook", async () => {
    const { poster, params, registryState, telegram, oidc } = await posterSetup({
      parameters: ORPHAN_PARAMETERS,
    });

    const result = await register(poster);

    expect(result).toEqual({ bot: "sprout", repo: "octo/sprout" });
    expect(oidc.verify).toHaveBeenCalledWith("jwt");
    expect(params.values["/centaur/bots/sprout/repo"]).toBe("octo/sprout");
    expect(await readRegistryEntry(registryState, "sprout")).toEqual({
      platforms: { telegram: { respond_to: "mention", bot_messages: "ignore" } },
    });
    expect(telegram.setWebhook).toHaveBeenCalledExactlyOnceWith(
      "sprout-token",
      `${FUNCTION_URL.replace(/\/$/, "")}/telegram/sprout`,
      "sprout-secret",
    );
  });

  it("is idempotent for the repo that already owns the bot", async () => {
    const { poster, params } = await posterSetup({
      parameters: { ...ORPHAN_PARAMETERS, "/centaur/bots/sprout/repo": "octo/sprout" },
    });

    await expect(register(poster)).resolves.toMatchObject({ repo: "octo/sprout" });
    expect(params.values["/centaur/bots/sprout/repo"]).toBe("octo/sprout");
  });

  it("registers a Slack bot without calling setWebhook", async () => {
    const { poster, params, telegram } = await posterSetup({
      parameters: connectionParameters({
        name: "inbox",
        platform: "slack",
        token: "xoxb",
        webhookSecret: "sig",
      }),
    });

    await register(poster, registerConfigText({ bot: "inbox", platforms: "{slack: {}}" }));

    expect(params.values["/centaur/bots/inbox/repo"]).toBe("octo/sprout");
    expect(telegram.setWebhook).not.toHaveBeenCalled();
  });

  it.each(["allow: [maintainer]", "chats: [household]"])(
    "rejects a config with the removed key %s",
    async (line) => {
      const { poster, registryState } = await posterSetup({ parameters: ORPHAN_PARAMETERS });
      const [key, value] = line.split(": ") as [string, string];

      await expect(register(poster, registerConfigText({ [key]: value }))).rejects.toThrow(
        new RegExp(`${key}: .*admin approval.*centaur access`),
      );
      expect(await readRegistryEntry(registryState, "sprout")).toBeNull();
    },
  );

  it("stores each declared platform's settings from the config in the registry entry", async () => {
    const { poster, registryState } = await posterSetup({
      parameters: { ...ORPHAN_PARAMETERS, ...SPROUT_SLACK_PARAMETERS },
    });

    await register(
      poster,
      registerConfigText({
        platforms:
          "{telegram: {respond_to: all, handle: sprout_bot, bot_messages: mention}, slack: {}}",
      }),
    );

    expect(await readRegistryEntry(registryState, "sprout")).toEqual({
      platforms: {
        telegram: { respond_to: "all", handle: "sprout_bot", bot_messages: "mention" },
        slack: { respond_to: "mention", bot_messages: "ignore" },
      },
    });
  });

  it("sets the webhook only for the Telegram connection of a two-platform bot", async () => {
    const { poster, params, telegram } = await posterSetup({
      parameters: { ...ORPHAN_PARAMETERS, ...SPROUT_SLACK_PARAMETERS },
    });

    await register(poster, registerConfigText({ platforms: "{telegram: {}, slack: {}}" }));

    expect(params.values["/centaur/bots/sprout/repo"]).toBe("octo/sprout");
    expect(telegram.setWebhook).toHaveBeenCalledExactlyOnceWith(
      "sprout-token",
      `${FUNCTION_URL.replace(/\/$/, "")}/telegram/sprout`,
      "sprout-secret",
    );
  });

  it("leaves a connection the config does not declare untouched and unlisted", async () => {
    const { poster, params, registryState, telegram } = await posterSetup({
      parameters: { ...ORPHAN_PARAMETERS, ...SPROUT_SLACK_PARAMETERS },
    });
    const slackParameters = Object.entries(params.values).filter(([name]) =>
      name.includes("/platforms/slack/"),
    );

    await register(poster, registerConfigText({ platforms: "{telegram: {}}" }));

    expect(slackParameters).not.toHaveLength(0);
    for (const [name, value] of slackParameters) expect(params.values[name]).toBe(value);
    expect(await readRegistryEntry(registryState, "sprout")).toEqual(REGISTERED_ENTRY);
    expect(telegram.setWebhook).toHaveBeenCalledOnce();
  });

  describe("first-registration race", () => {
    it("refuses the loser when another repo binds the bot between the read and the write", async () => {
      const { poster, params, registryState, telegram } = await posterSetup({
        parameters: ORPHAN_PARAMETERS,
      });
      vi.spyOn(params, "putIfAbsent").mockImplementationOnce(async (name) => {
        params.values[name] = "octo/rival";
        return false;
      });

      await expect(register(poster)).rejects.toThrow(/bound to octo\/rival/);

      expect(params.values["/centaur/bots/sprout/repo"]).toBe("octo/rival");
      expect(await readRegistryEntry(registryState, "sprout")).toBeNull();
      expect(telegram.setWebhook).not.toHaveBeenCalled();
    });

    it("lets the same repo through when a concurrent registration of it won the write", async () => {
      const { poster, params } = await posterSetup({ parameters: ORPHAN_PARAMETERS });
      vi.spyOn(params, "putIfAbsent").mockImplementationOnce(async (name) => {
        params.values[name] = "octo/sprout";
        return false;
      });

      await expect(register(poster)).resolves.toMatchObject({ repo: "octo/sprout" });
    });
  });

  describe("refusals", () => {
    it.each<[string, Record<string, string>, RegExp]>([
      ["a bot bound to another repo", { bot: "garden" }, /bound to octo\/garden/],
      ["a bot with no secrets", { bot: "ghost" }, /no telegram connection/],
      ["an unknown bot", { bot: "nobody" }, /no telegram connection/],
      [
        "an extra declared platform with no connection",
        { platforms: "{telegram: {}, slack: {}}" },
        /no slack connection/,
      ],
      [
        "a declared platform that differs from the stored one",
        { platforms: "{slack: {}}" },
        /no slack connection/,
      ],
    ])("%s", async (_name, overrides, message) => {
      const { poster, params, registryState, telegram } = await posterSetup({
        parameters: ORPHAN_PARAMETERS,
      });
      const before = { ...params.values };

      await expect(register(poster, registerConfigText(overrides))).rejects.toThrow(message);

      expect(params.values).toEqual(before);
      expect(await readRegistryEntry(registryState, overrides.bot ?? "sprout")).toEqual(
        overrides.bot === "garden" ? REGISTERED_ENTRY : null,
      );
      expect(telegram.setWebhook).not.toHaveBeenCalled();
    });

    it("an invalid config, reporting every issue", async () => {
      const { poster, params } = await posterSetup({ parameters: ORPHAN_PARAMETERS });

      await expect(register(poster, "bot: sprout\nplatforms: {irc: {}}")).rejects.toThrow(
        /platforms.*\nprovider:.*\nmodel:.*\nallowed_tools:/,
      );
      expect(params.values["/centaur/bots/sprout/repo"]).toBeUndefined();
    });

    it("a token that fails verification, before reading anything", async () => {
      const { poster, oidc, params } = await posterSetup({ parameters: ORPHAN_PARAMETERS });
      oidc.verify.mockRejectedValueOnce(new Error("bad signature"));

      await expect(register(poster)).rejects.toThrow("bad signature");
      expect(params.values["/centaur/bots/sprout/repo"]).toBeUndefined();
    });
  });
});
