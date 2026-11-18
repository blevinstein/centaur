import { describe, expect, it } from "vitest";
import { readRegistryEntry } from "../src/lambda/registry.js";
import {
  configText,
  FUNCTION_URL,
  ORPHAN_PARAMETERS,
  posterSetup,
} from "./helpers/poster-fixtures.js";

const register = (
  poster: Awaited<ReturnType<typeof posterSetup>>["poster"],
  config = configText(),
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
      allow: ["maintainer"],
      destination: "household",
      respond_to: "mention",
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
      parameters: {
        "/centaur/bots/inbox/platform": "slack",
        "/centaur/bots/inbox/token": "xoxb",
        "/centaur/bots/inbox/signing-secret": "sig",
      },
    });

    await register(poster, configText({ bot: "inbox", platform: "slack" }));

    expect(params.values["/centaur/bots/inbox/repo"]).toBe("octo/sprout");
    expect(telegram.setWebhook).not.toHaveBeenCalled();
  });

  it("omits destination from the registry entry when the config has none", async () => {
    const { poster, registryState } = await posterSetup({ parameters: ORPHAN_PARAMETERS });

    await register(poster, configText({ destination: undefined }));

    expect(await readRegistryEntry(registryState, "sprout")).toEqual({
      allow: ["maintainer"],
      respond_to: "mention",
    });
  });

  it("stores respond_to from the config in the registry entry", async () => {
    const { poster, registryState } = await posterSetup({ parameters: ORPHAN_PARAMETERS });

    await register(poster, configText({ respond_to: "all" }));

    expect(await readRegistryEntry(registryState, "sprout")).toMatchObject({ respond_to: "all" });
  });

  describe("refusals", () => {
    it.each<[string, Record<string, string>, RegExp]>([
      ["a bot bound to another repo", { bot: "garden" }, /bound to octo\/garden/],
      ["a bot with no secrets", { bot: "ghost" }, /no secrets in SSM/],
      ["an unknown bot", { bot: "nobody" }, /no secrets in SSM/],
      [
        "a platform that differs from the stored one",
        { platform: "slack" },
        /telegram bot, not slack/,
      ],
    ])("%s", async (_name, overrides, message) => {
      const { poster, params, registryState, telegram } = await posterSetup({
        parameters: ORPHAN_PARAMETERS,
      });
      const before = { ...params.values };

      await expect(register(poster, configText(overrides))).rejects.toThrow(message);

      expect(params.values).toEqual(before);
      expect(await readRegistryEntry(registryState, overrides.bot ?? "sprout")).toEqual(
        overrides.bot === "garden" ? { allow: ["maintainer"], destination: "household" } : null,
      );
      expect(telegram.setWebhook).not.toHaveBeenCalled();
    });

    it("an invalid config, reporting every issue", async () => {
      const { poster, params } = await posterSetup({ parameters: ORPHAN_PARAMETERS });

      await expect(register(poster, "bot: sprout\nplatform: irc")).rejects.toThrow(
        /platform:.*\nallow:.*\nallowed_tools:/,
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
