import { describe, expect, it } from "vitest";
import {
  approvedParameter,
  approvedPrefix,
  blockedParameter,
  blockedPrefix,
  connectionPath,
  parseBotParameter,
  repoParameter,
  tokenParameter,
  webhookSecretParameter,
} from "../src/lambda/connection-paths.js";

describe("connection paths", () => {
  it("hangs every per-connection key off the connection's base path", () => {
    expect(connectionPath("garden", "telegram")).toBe("/centaur/bots/garden/platforms/telegram");
    expect(tokenParameter("garden", "telegram")).toBe(
      "/centaur/bots/garden/platforms/telegram/token",
    );
    expect(approvedPrefix("garden", "slack", "chat")).toBe(
      "/centaur/bots/garden/platforms/slack/approved-chats",
    );
    expect(approvedParameter("garden", "slack", "user", "U1")).toBe(
      "/centaur/bots/garden/platforms/slack/approved-users/U1",
    );
    expect(blockedPrefix("garden", "telegram", "user")).toBe(
      "/centaur/bots/garden/platforms/telegram/blocked/user",
    );
    expect(blockedParameter("garden", "telegram", "chat", "-1")).toBe(
      "/centaur/bots/garden/platforms/telegram/blocked/chat/-1",
    );
  });

  it("keeps the repo binding at the bot level", () => {
    expect(repoParameter("garden")).toBe("/centaur/bots/garden/repo");
  });

  it.each([
    ["telegram", "webhook-secret"],
    ["slack", "signing-secret"],
  ] as const)("names the %s webhook secret %s", (platform, key) => {
    expect(webhookSecretParameter("garden", platform)).toBe(
      `/centaur/bots/garden/platforms/${platform}/${key}`,
    );
  });

  it.each([
    [repoParameter("garden"), { bot: "garden", key: "repo" }],
    [tokenParameter("garden", "slack"), { bot: "garden", platform: "slack", key: "token" }],
    [approvedParameter("garden", "slack", "chat", "C1"), { bot: "garden" }],
    ["/centaur/bots/garden/platforms/matrix/token", { bot: "garden" }],
    ["/centaur/bots/garden/token", { bot: "garden" }],
    ["/centaur/chats/household", undefined],
  ])("parses %s", (name, expected) => {
    expect(parseBotParameter(name)).toEqual(expected);
  });
});
