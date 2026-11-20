import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILES,
  configRepoRoot,
  findConfigFile,
  readConfigText,
} from "../src/workflows/config-file.js";
import { createWorkspace } from "./helpers/workflow-fixtures.js";

const [NEW, LEGACY] = CONFIG_FILES;

describe("findConfigFile", () => {
  it.each([
    ["only the legacy file", [LEGACY], LEGACY],
    ["only the new file", [NEW], NEW],
  ])("uses %s", async (_name, files, expected) => {
    const { root } = await createWorkspace(Object.fromEntries(files.map((f) => [f, f])));
    expect(await findConfigFile(root)).toBe(join(root, expected));
    expect(await readConfigText(root)).toBe(expected);
  });

  it("fails naming both files when both exist", async () => {
    const { root } = await createWorkspace({ [NEW]: "a", [LEGACY]: "b" });
    await expect(findConfigFile(root)).rejects.toThrow(
      /both \.centaur\/config\.yml and \.centaur\.yml.*remove one/,
    );
  });

  it("fails naming both paths when neither exists", async () => {
    const { root } = await createWorkspace({ ".centaur/persona.md": "x" });
    await expect(findConfigFile(root)).rejects.toThrow(
      /expected \.centaur\/config\.yml or \.centaur\.yml/,
    );
  });
});

describe("configRepoRoot", () => {
  it.each([
    ["/repo/.centaur.yml", "/repo"],
    ["/repo/.centaur/config.yml", "/repo"],
    ["/repo/other/config.yml", "/repo/other"],
    ["/repo/sub/.centaur.yml", "/repo/sub"],
  ])("maps %s to %s", (path, expected) => {
    expect(configRepoRoot(path)).toBe(expected);
  });
});
