import { describe, expect, it, vi } from "vitest";
import { CONFIG_FILES } from "../src/workflows/config-file.js";
import { registerRepo } from "../src/workflows/register.js";
import { configText, createFakeAws, createWorkspace } from "./helpers/workflow-fixtures.js";

const setup = async (
  config = configText(),
  handler = () => ({ bot: "sprout", repo: "octo/sprout" }),
  configFile = ".centaur.yml",
) => {
  const aws = createFakeAws(handler);
  const { root } = await createWorkspace({ [configFile]: config });
  const mask = vi.fn();
  const run = () =>
    registerRepo({ workspace: root, poster: aws.poster, fetchToken: async () => "jwt", mask });
  return { aws, mask, run };
};

describe("registerRepo", () => {
  it("masks the token and sends it with the config text", async () => {
    const { aws, mask, run } = await setup();
    expect(await run()).toEqual({ bot: "sprout", repo: "octo/sprout" });
    expect(mask).toHaveBeenCalledWith("jwt");
    expect(aws.requests).toEqual([{ operation: "register", token: "jwt", config: configText() }]);
  });

  it.each(CONFIG_FILES)("registers the config at %s", async (configFile) => {
    const { aws, run } = await setup(configText(), undefined, configFile);
    await run();
    expect(aws.requests).toEqual([{ operation: "register", token: "jwt", config: configText() }]);
  });

  it("rejects an invalid config before requesting a token or invoking", async () => {
    const { aws, run } = await setup("bot: Bad");
    await expect(run()).rejects.toThrow(/invalid/);
    expect(aws.requests).toEqual([]);
  });

  it("surfaces a FunctionError message for register", async () => {
    const { run } = await setup(configText(), () => {
      throw new Error("bot already bound");
    });
    await expect(run()).rejects.toThrow("poster register failed (Error): bot already bound");
  });
});

describe("poster client", () => {
  it("omits the error message for thread operations", async () => {
    const aws = createFakeAws(() => {
      throw new Error("secret chat text");
    });
    await expect(
      aws.poster.call({ operation: "post", bot: "sprout", threadId: "t", text: "x" }),
    ).rejects.toThrow(/^poster post failed \(Error\)$/);
  });
});
