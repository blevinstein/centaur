import { afterEach, describe, expect, it, vi } from "vitest";
import { createDynamoDbState } from "../src/dynamodb-state/index.js";
import { PULL_REQUEST_TTL_MS, pullRequestKey } from "../src/lambda/pull-requests.js";
import { threadKey } from "../src/thread-key.js";
import { createFreshTable, scanItems } from "./helpers/dynamodb-local.js";
import { posterSetup } from "./helpers/poster-fixtures.js";

const THREAD_ID = "telegram:-100500:77";
const DAY_MS = 24 * 60 * 60 * 1000;
const LINK = {
  operation: "link-pull-request",
  token: "jwt",
  bot: "garden",
  threadId: THREAD_ID,
  pullRequest: 12,
} as const;
const RESOLVE = { operation: "resolve-pull-request", token: "jwt", pullRequest: 12 } as const;

async function setup(repository = "octo/garden") {
  const table = await createFreshTable();
  return {
    table,
    ...(await posterSetup({ registryState: createDynamoDbState(table), repository })),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("link-pull-request and resolve-pull-request", () => {
  it("resolves a linked pull request to its bot, thread key and raw thread", async () => {
    const { poster, oidc } = await setup();

    await expect(poster(LINK)).resolves.toEqual({ linked: true });
    const resolved = await poster(RESOLVE);

    expect(oidc.verify).toHaveBeenCalledWith("jwt");
    expect(resolved).toEqual({
      found: true,
      bot: "garden",
      threadKey: threadKey("garden", THREAD_ID),
      threadId: THREAD_ID,
    });
  });

  it("stores the record under the caller's repository with a 90-day expiry", async () => {
    const { poster, table } = await setup();

    await poster(LINK);

    const item = (await scanItems(table)).find((candidate) =>
      String(candidate.pk).includes(pullRequestKey("octo/garden", 12)),
    );
    expect(item?.expiresAt).toBeGreaterThan(Date.now() + PULL_REQUEST_TTL_MS - 5_000);
    expect(item?.expiresAt).toBeLessThanOrEqual(Date.now() + PULL_REQUEST_TTL_MS);
  });

  it("reports a pull request with no record as not found", async () => {
    const { poster } = await setup();

    await expect(poster(RESOLVE)).resolves.toEqual({ found: false });
  });

  it("refuses to link a bot bound to a different repository", async () => {
    const { poster } = await setup("octo/other");

    await expect(poster(LINK)).rejects.toThrow('bot "garden" is not bound to octo/other');
    await expect(poster(RESOLVE)).resolves.toEqual({ found: false });
  });

  it.each(["unbound", "nobody"])("refuses to link the unbound or unknown bot %s", async (bot) => {
    const { poster } = await setup();

    await expect(poster({ ...LINK, bot })).rejects.toThrow(`bot "${bot}" is not bound`);
  });

  it("does not resolve a record whose bot has since been bound elsewhere", async () => {
    const { poster, params } = await setup();
    await poster(LINK);
    params.values["/centaur/bots/garden/repo"] = "octo/moved";

    await expect(poster(RESOLVE)).resolves.toEqual({ found: false });
  });

  it("keeps records of different repositories apart", async () => {
    const { poster, oidc } = await setup();
    await poster(LINK);
    oidc.verify.mockResolvedValueOnce({ repository: "octo/notes" });

    await expect(poster(RESOLVE)).resolves.toEqual({ found: false });
  });

  it.each(["link-pull-request", "resolve-pull-request"] as const)(
    "rejects a payload that names a repository on %s",
    async (operation) => {
      const { poster, oidc } = await setup("octo/other");
      const request = operation === "link-pull-request" ? LINK : RESOLVE;

      await expect(poster({ ...request, repository: "octo/garden" })).rejects.toThrow();
      expect(oidc.verify).not.toHaveBeenCalled();
    },
  );

  it("refreshes the expiry on every resolve", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { poster, table } = await setup();
    await poster(LINK);

    vi.setSystemTime(start + 60 * DAY_MS);
    await poster(RESOLVE);

    const [item] = (await scanItems(table)).filter((candidate) =>
      String(candidate.pk).includes(pullRequestKey("octo/garden", 12)),
    );
    expect(item?.expiresAt).toBe(start + 60 * DAY_MS + PULL_REQUEST_TTL_MS);
  });

  it("refreshes the expiry when the same pull request is linked again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { poster, table } = await setup();
    await poster(LINK);

    vi.setSystemTime(start + 30 * DAY_MS);
    await poster(LINK);

    const [item] = (await scanItems(table)).filter((candidate) =>
      String(candidate.pk).includes(pullRequestKey("octo/garden", 12)),
    );
    expect(item?.expiresAt).toBe(start + 30 * DAY_MS + PULL_REQUEST_TTL_MS);
  });

  it("stops resolving after the record expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { poster } = await setup();
    await poster(LINK);

    vi.setSystemTime(start + PULL_REQUEST_TTL_MS + DAY_MS);

    await expect(poster(RESOLVE)).resolves.toEqual({ found: false });
  });

  it.each([0, -1, 1.5, "12"])("rejects pull request number %s", async (pullRequest) => {
    const { poster } = await setup();

    await expect(poster({ ...LINK, pullRequest })).rejects.toThrow();
  });
});
