import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { threadKey } from "../src/thread-key.js";
import { prepare } from "../src/workflows/prepare.js";
import { DIRECT_CONFIG } from "./helpers/execution-mode-fixtures.js";
import { commitFile, createClone, git } from "./helpers/git-fixtures.js";
import { candidatePr, targetSetup } from "./helpers/pr-target-fixtures.js";
import { setup } from "./helpers/turn-fixtures.js";
import { configText, message, THREAD } from "./helpers/workflow-fixtures.js";

const BRANCH = `centaur/sprout-${threadKey("sprout", THREAD)}`;

async function threadTurn(options: { config?: string; open?: boolean } = {}) {
  const config = options.config ?? configText();
  const clone = await createClone();
  await commitFile(clone.work, ".centaur.yml", config);
  await commitFile(clone.work, ".centaur/persona.md", "Be kind.");
  await git(clone.work, "push", "origin", "HEAD:main");
  await git(clone.work, "push", "origin", `HEAD:refs/heads/${BRANCH}`);
  await clone.advanceRemote("turn-one.md", "first turn\n", BRANCH);
  await git(clone.work, "switch", "--detach", "origin/main");
  const target = targetSetup({
    open: options.open === false ? [] : [candidatePr(5, { headRef: BRANCH })],
  });
  const turn = await setup([message("1", "hi")], config);
  const out = await prepare(turn.deps({ workspace: clone.work, targets: target.targets }));
  const hasFile = (file: string) =>
    access(join(clone.work, file)).then(
      () => true,
      () => false,
    );
  return { ...clone, ...target, out, hasFile };
}

describe("prepare with an open pull request on the thread branch", () => {
  it("starts the agent from the branch tip and reads the config from the default branch", async () => {
    const { out, work, hasFile } = await threadTurn();

    expect(out).toMatchObject({ skip: false, branch: BRANCH, thread_pull_request: "5" });
    expect(out.config_root).not.toBe("");
    expect(await hasFile("turn-one.md")).toBe(true);
    expect(await readFile(join(work, ".centaur.yml"), "utf8")).toContain("bot: sprout");
    expect(out.claude_args).toContain("--setting-sources user");
    expect(out.claude_args).toContain(
      `--append-system-prompt-file ${join(out.config_root, ".centaur/persona.md")}`,
    );
  });

  it.each([
    ["no pull request is open on the branch, as after a merge", { open: false }],
    ["the mode is direct", { config: DIRECT_CONFIG }],
  ])("starts from the default branch when %s", async (_name, options) => {
    const { out, hasFile } = await threadTurn(options);

    expect(out).toMatchObject({
      skip: false,
      branch: BRANCH,
      thread_pull_request: "",
      config_root: "",
    });
    expect(await hasFile("turn-one.md")).toBe(false);
    expect(out.claude_args).not.toContain("--setting-sources");
  });

  it("does not look for the branch when the mode is direct", async () => {
    const { github } = await threadTurn({ config: DIRECT_CONFIG });

    expect(github.listOpenPullRequests).not.toHaveBeenCalled();
  });
});
