import { describe, expect, it } from "vitest";
import { readRequirePosterToken } from "../src/lambda/caller-check.js";
import {
  BOT_OPERATIONS,
  CALLER_CHECKED_OPERATIONS,
  verifyingPosterSetup,
} from "./helpers/caller-check-fixtures.js";
import { posterSetup } from "./helpers/poster-fixtures.js";

const bots = Object.entries(BOT_OPERATIONS);
const all = Object.entries(CALLER_CHECKED_OPERATIONS);

describe("poster caller check on a bound bot", () => {
  it.each(bots)("%s accepts a token from the bot's repository", async (_name, request) => {
    const { poster, oidc } = await posterSetup({
      requirePosterToken: true,
      repository: "octo/garden",
    });

    await expect(poster({ ...request, token: "jwt" })).resolves.toBeDefined();
    expect(oidc.verify).toHaveBeenCalledWith("jwt");
  });

  it.each(bots)("%s rejects a token from another repository", async (_name, request) => {
    const { poster, chatFor } = await posterSetup({ repository: "octo/other" });

    await expect(poster({ ...request, token: "jwt" })).rejects.toThrow(
      'bot "garden" is not bound to octo/other',
    );
    expect(chatFor).not.toHaveBeenCalled();
  });

  it.each(bots)("%s rejects a bot that is not bound to any repository", async (_name, request) => {
    const { poster, chatFor } = await posterSetup({ repository: "octo/garden" });

    await expect(poster({ ...request, bot: "unbound", token: "jwt" })).rejects.toThrow(
      'bot "unbound" is not bound to octo/garden',
    );
    expect(chatFor).not.toHaveBeenCalled();
  });

  it.each(bots)("%s rejects an unknown bot", async (_name, request) => {
    const { poster } = await posterSetup({ repository: "octo/garden" });

    await expect(poster({ ...request, bot: "nobody", token: "jwt" })).rejects.toThrow(
      'bot "nobody" is not bound',
    );
  });
});

describe("poster caller check on get-mcp-policy", () => {
  const request = CALLER_CHECKED_OPERATIONS["get-mcp-policy"];

  it("serves the policy to the repository the bot is bound to", async () => {
    const { poster } = await posterSetup({
      requirePosterToken: true,
      repository: "octo/garden",
      globalMcpPolicy: "permit;",
    });

    await expect(poster({ ...request, token: "jwt" })).resolves.toEqual({ policy: "permit;" });
  });

  it("refuses a token from another repository, naming a bound bot", async () => {
    const { poster } = await posterSetup({ repository: "octo/other", globalMcpPolicy: "permit;" });

    await expect(poster({ ...request, token: "jwt" })).rejects.toThrow(
      'bot "garden" is not bound to octo/other',
    );
  });

  it("serves a bot that is not bound yet, as the register step reads it", async () => {
    const { poster } = await posterSetup({
      requirePosterToken: true,
      repository: "octo/new-repo",
      globalMcpPolicy: "permit;",
    });

    await expect(poster({ ...request, bot: "unbound", token: "jwt" })).resolves.toEqual({
      policy: "permit;",
    });
  });

  it("requires a bot", async () => {
    const { poster } = await posterSetup();

    await expect(poster({ operation: "get-mcp-policy", token: "jwt" })).rejects.toThrow();
  });
});

describe("poster calls without a token", () => {
  it.each(all)(
    "%s warns with the operation and bot only when not required",
    async (_name, request) => {
      const { poster, logger } = await posterSetup();

      await poster(request);

      expect(logger.warn).toHaveBeenCalledWith("poster call without a token", {
        operation: request.operation,
        ...("bot" in request ? { bot: request.bot } : {}),
      });
    },
  );

  it.each(all)("%s does not warn when a token is present", async (_name, request) => {
    const { poster, logger } = await posterSetup({ repository: "octo/garden" });

    await poster({ ...request, token: "jwt" });

    expect(logger.warn).not.toHaveBeenCalledWith("poster call without a token", expect.anything());
  });

  it("does not warn when the token is required", async () => {
    const { poster, logger } = await posterSetup({ requirePosterToken: true });

    await expect(poster(CALLER_CHECKED_OPERATIONS.post)).rejects.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("REQUIRE_POSTER_TOKEN", () => {
  it.each(all)("%s rejects a request with no token when required", async (_name, request) => {
    const { poster, chatFor } = await posterSetup({ requirePosterToken: true });

    await expect(poster(request)).rejects.toThrow("requires a GitHub OIDC token");
    expect(chatFor).not.toHaveBeenCalled();
  });

  it.each(all)("%s accepts a request with no token otherwise", async (_name, request) => {
    const { poster, oidc } = await posterSetup();

    await expect(poster(request)).resolves.toBeDefined();
    expect(oidc.verify).not.toHaveBeenCalled();
  });

  it.each(all)("%s rejects an empty token even when not required", async (_name, request) => {
    const { poster } = await posterSetup();

    await expect(poster({ ...request, token: "" })).rejects.toThrow();
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
  ])("reads %j as %s", (raw, expected) => {
    expect(readRequirePosterToken({ REQUIRE_POSTER_TOKEN: raw })).toBe(expected);
  });

  it.each(["TRUE", "1", "yes", " true"])("fails the cold start on %j", (raw) => {
    expect(() => readRequirePosterToken({ REQUIRE_POSTER_TOKEN: raw })).toThrow(
      "REQUIRE_POSTER_TOKEN",
    );
  });
});

describe.each([true, false])(
  "poster caller check with a real verifier (required: %s)",
  (required) => {
    it.each(all)("%s accepts a valid token", async (_name, request) => {
      const { poster, signGarden } = await verifyingPosterSetup(required);

      await expect(poster({ ...request, token: await signGarden() })).resolves.toBeDefined();
    });

    it.each(all)("%s rejects an expired token", async (_name, request) => {
      const { poster, signGarden, chatFor } = await verifyingPosterSetup(required);

      await expect(
        poster({ ...request, token: await signGarden({}, undefined, { expiresIn: "-1m" }) }),
      ).rejects.toThrow();
      expect(chatFor).not.toHaveBeenCalled();
    });

    it.each(all)("%s rejects a token for another audience", async (_name, request) => {
      const { poster, signGarden } = await verifyingPosterSetup(required);

      await expect(
        poster({ ...request, token: await signGarden({ aud: "elsewhere" }) }),
      ).rejects.toThrow();
    });

    it.each(all)("%s rejects a token from another owner", async (_name, request) => {
      const { poster, signGarden } = await verifyingPosterSetup(required);
      const token = await signGarden({ repository: "mallory/garden", repository_owner: "mallory" });

      await expect(poster({ ...request, token })).rejects.toThrow();
    });

    it.each(all)("%s rejects a token signed with another key", async (_name, request) => {
      const { poster, signGarden, wrongKey } = await verifyingPosterSetup(required);

      await expect(poster({ ...request, token: await signGarden({}, wrongKey) })).rejects.toThrow();
    });

    it.each(bots)("%s rejects a valid token from another repository", async (_name, request) => {
      const { poster, sign, chatFor } = await verifyingPosterSetup(required);

      await expect(
        poster({ ...request, token: await sign({ repository: "octo/other" }) }),
      ).rejects.toThrow('bot "garden" is not bound to octo/other');
      expect(chatFor).not.toHaveBeenCalled();
    });
  },
);
