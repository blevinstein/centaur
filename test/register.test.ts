import { describe, expect, it, vi } from "vitest";
import { readRegistryEntry } from "../src/lambda/registry.js";
import {
  FORBID_UNTRUSTED,
  forbidForBot,
  GITHUB_SERVER_CONFIG,
  PERMIT_ANY_REMOTE,
  PERMIT_GITHUB,
} from "./helpers/mcp-policy-fixtures.js";
import {
  configText,
  FUNCTION_URL,
  ORPHAN_PARAMETERS,
  posterSetup,
  REGISTERED_ENTRY,
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
    expect(await readRegistryEntry(registryState, "sprout")).toEqual({ respond_to: "mention" });
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

  it.each(["allow: [maintainer]", "chats: [household]"])(
    "rejects a config with the removed key %s",
    async (line) => {
      const { poster, registryState } = await posterSetup({ parameters: ORPHAN_PARAMETERS });
      const [key, value] = line.split(": ") as [string, string];

      await expect(register(poster, configText({ [key]: value }))).rejects.toThrow(
        new RegExp(`${key}: .*admin approval.*centaur access`),
      );
      expect(await readRegistryEntry(registryState, "sprout")).toBeNull();
    },
  );

  it("stores respond_to from the config in the registry entry", async () => {
    const { poster, registryState } = await posterSetup({ parameters: ORPHAN_PARAMETERS });

    await register(poster, configText({ respond_to: "all" }));

    expect(await readRegistryEntry(registryState, "sprout")).toMatchObject({ respond_to: "all" });
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
        overrides.bot === "garden" ? REGISTERED_ENTRY : null,
      );
      expect(telegram.setWebhook).not.toHaveBeenCalled();
    });

    it("an invalid config, reporting every issue", async () => {
      const { poster, params } = await posterSetup({ parameters: ORPHAN_PARAMETERS });

      await expect(register(poster, "bot: sprout\nplatform: irc")).rejects.toThrow(
        /platform:.*\nprovider:.*\nmodel:.*\nallowed_tools:/,
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

  describe("MCP server policy", () => {
    const GLOBAL_POLICY = "/centaur/policy/mcp";
    const BOT_POLICY = "/centaur/bots/sprout/mcp-policy";
    const withServers = () => configText(GITHUB_SERVER_CONFIG);
    const registerWith = (policies: Record<string, string>, config = withServers()) =>
      posterSetup({ parameters: { ...ORPHAN_PARAMETERS, ...policies } }).then((setup) => ({
        ...setup,
        result: register(setup.poster, config),
      }));

    it("rejects a server when no policy exists, naming the server and binding nothing", async () => {
      const { result, params, registryState } = await registerWith({});

      await expect(result).rejects.toThrow(
        /mcp_servers violate the operator policy:\nmcp_servers\.ghmcp: not permitted/,
      );
      expect(params.values["/centaur/bots/sprout/repo"]).toBeUndefined();
      expect(await readRegistryEntry(registryState, "sprout")).toBeNull();
    });

    it("never reads a policy for a config without servers", async () => {
      const { poster, params } = await posterSetup({ parameters: ORPHAN_PARAMETERS });
      const get = vi.spyOn(params, "get");

      await register(poster);

      expect(get.mock.calls.map(([name]) => name)).not.toContain(GLOBAL_POLICY);
      expect(get.mock.calls.map(([name]) => name)).not.toContain(BOT_POLICY);
    });

    it("accepts a server a global policy permits", async () => {
      const { result } = await registerWith({ [GLOBAL_POLICY]: PERMIT_GITHUB });
      await expect(result).resolves.toMatchObject({ repo: "octo/sprout" });
    });

    it("accepts a server a bot policy permits", async () => {
      const { result } = await registerWith({ [BOT_POLICY]: PERMIT_GITHUB });
      await expect(result).resolves.toMatchObject({ repo: "octo/sprout" });
    });

    it("rejects a server a global forbid denies even when the bot policy permits it", async () => {
      const { result } = await registerWith({
        [GLOBAL_POLICY]:
          'forbid(principal, action, resource) when { resource.host like "*.githubcopilot.com" };',
        [BOT_POLICY]: PERMIT_ANY_REMOTE,
      });
      await expect(result).rejects.toThrow(/forbidden by policy global\.0/);
    });

    it("rejects a server only for the bot whose own policy forbids it", async () => {
      const policies = { [GLOBAL_POLICY]: PERMIT_GITHUB, [BOT_POLICY]: forbidForBot("sprout") };
      await expect((await registerWith(policies)).result).rejects.toThrow(
        /forbidden by policy bot\.0/,
      );
      const other = await registerWith({
        [GLOBAL_POLICY]: PERMIT_GITHUB,
        "/centaur/bots/garden/mcp-policy": forbidForBot("garden"),
      });
      await expect(other.result).resolves.toMatchObject({ repo: "octo/sprout" });
    });

    it("rejects a server when a stored policy is malformed", async () => {
      const { result } = await registerWith({ [GLOBAL_POLICY]: "permit(" });
      await expect(result).rejects.toThrow(/operator policy is invalid/);
    });

    it("accepts a server that an unrelated forbid does not match", async () => {
      const { result } = await registerWith({
        [GLOBAL_POLICY]: `${PERMIT_GITHUB}\n${FORBID_UNTRUSTED}`,
      });
      await expect(result).resolves.toMatchObject({ repo: "octo/sprout" });
    });
  });
});
