import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { committedExecutionMode } from "../src/workflows/config-file.js";
import { DIRECT_EXECUTION, minimalConfig } from "./helpers/config-fixtures.js";
import { commitFile, createClone } from "./helpers/git-fixtures.js";

const CONFIG = ".centaur.yml";
const DIRECT = `${minimalConfig}\n${DIRECT_EXECUTION}\n`;
const PULL_REQUEST = `${minimalConfig}\nexecution: {mode: pull_request}\n`;

describe("committedExecutionMode", () => {
  it("ignores a workspace config the agent edited to direct", async () => {
    const { work } = await createClone();
    await commitFile(work, CONFIG, PULL_REQUEST);
    await writeFile(join(work, CONFIG), DIRECT);

    await expect(committedExecutionMode(work)).resolves.toBe("pull_request");
  });

  it("reads direct from the committed config, even when the workspace was edited away from it", async () => {
    const { work } = await createClone();
    await commitFile(work, CONFIG, DIRECT);
    await expect(committedExecutionMode(work)).resolves.toBe("direct");

    await writeFile(join(work, CONFIG), PULL_REQUEST);
    await expect(committedExecutionMode(work)).resolves.toBe("direct");
  });

  it("reads the config under a sub-folder root", async () => {
    const { work } = await createClone();
    await commitFile(work, "apps/garden/.centaur/config.yml", DIRECT);

    await expect(committedExecutionMode(work, "apps/garden")).resolves.toBe("direct");
    await expect(committedExecutionMode(work, ".")).resolves.toBe("pull_request");
  });

  it.each([
    ["no committed config", async () => undefined],
    ["an invalid committed config", (work: string) => commitFile(work, CONFIG, "not: [valid")],
    [
      "both config files committed",
      async (work: string) => {
        await commitFile(work, CONFIG, DIRECT);
        await commitFile(work, ".centaur/config.yml", DIRECT);
      },
    ],
  ])("plans pull_request for %s, whatever the workspace says", async (_name, commit) => {
    const { work } = await createClone();
    await commit(work);
    await writeFile(join(work, CONFIG), DIRECT);

    await expect(committedExecutionMode(work)).resolves.toBe("pull_request");
  });

  it("reads the file outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centaur-nogit-"));
    await writeFile(join(dir, CONFIG), DIRECT);

    await expect(committedExecutionMode(dir)).resolves.toBe("direct");
  });
});
