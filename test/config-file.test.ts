import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSingleConfigStyle,
  CONFIG_FILES,
  configRepoRoot,
  findConfigFile,
  readConfigText,
  resolveRoot,
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

describe("root", () => {
  it.each([
    ["the new file", NEW],
    ["the legacy file", LEGACY],
  ])("finds %s under a sub-folder", async (_name, file) => {
    const { root } = await createWorkspace({ [`apps/garden/${file}`]: "sub", [LEGACY]: "top" });
    expect(await findConfigFile(root, "apps/garden")).toBe(join(root, "apps/garden", file));
    expect(await readConfigText(root, "apps/garden")).toBe("sub");
  });

  it("treats a root of . as the base", async () => {
    const { root } = await createWorkspace({ [LEGACY]: "top" });
    expect(await findConfigFile(root, ".")).toBe(await findConfigFile(root));
  });

  it("still fails when a sub-folder holds both files", async () => {
    const { root } = await createWorkspace({ [`apps/a/${NEW}`]: "a", [`apps/a/${LEGACY}`]: "b" });
    await expect(findConfigFile(root, "apps/a")).rejects.toThrow(/Found both.*apps\/a/);
  });

  it("fails naming the sub-folder when it has no config", async () => {
    const { root } = await createWorkspace({ [LEGACY]: "top", "apps/a/x": "x" });
    await expect(findConfigFile(root, "apps/a")).rejects.toThrow(/No Centaur config in .*apps\/a/);
  });

  it.each(["..", "../x", "a/../..", "/etc", "a//b", "a/", "a\\b", ""])(
    "rejects the root %j",
    async (bad) => {
      const { root } = await createWorkspace({ [LEGACY]: "top" });
      await expect(resolveRoot(root, bad)).rejects.toThrow(/Invalid Centaur root/);
    },
  );

  it("rejects a root that does not exist", async () => {
    const { root } = await createWorkspace({ [LEGACY]: "top" });
    await expect(resolveRoot(root, "missing")).rejects.toThrow(/does not exist/);
  });

  it("rejects a root that is a symlink out of the base", async () => {
    const { root } = await createWorkspace({ [LEGACY]: "top" });
    const { root: outside } = await createWorkspace({ [LEGACY]: "outside" });
    await symlink(outside, join(root, "escape"));
    await expect(findConfigFile(root, "escape")).rejects.toThrow(/resolves outside/);
  });

  it("accepts a symlink that stays inside the base", async () => {
    const { root } = await createWorkspace({ [`real/${LEGACY}`]: "in" });
    await symlink(join(root, "real"), join(root, "link"));
    expect(await readConfigText(root, "link")).toBe("in");
  });
});

describe("assertSingleConfigStyle", () => {
  it.each([
    ["only a root config", { [LEGACY]: "a", "apps/x/readme": "x" }, "."],
    ["only sub-folder configs", { [`apps/a/${LEGACY}`]: "a", [`apps/b/${NEW}`]: "b" }, "apps/a"],
    ["a config only under node_modules", { [LEGACY]: "a", [`node_modules/p/${LEGACY}`]: "p" }, "."],
  ])("accepts %s", async (_name, files, root) => {
    const { root: base } = await createWorkspace(files);
    await expect(assertSingleConfigStyle(base, root)).resolves.toBeUndefined();
  });

  it.each(["apps/a", "."])("rejects a root and a sub-folder config for root %s", async (root) => {
    const { root: base } = await createWorkspace({ [LEGACY]: "a", [`apps/a/${NEW}`]: "b" });
    await expect(assertSingleConfigStyle(base, root)).rejects.toThrow(
      /root \(.*\.centaur\.yml\) and in a sub-folder \(.*apps\/a\/\.centaur\/config\.yml\)/,
    );
  });
});
