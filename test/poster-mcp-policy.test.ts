import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_MCP_POLICY_FILE, readBundledMcpPolicy } from "../src/lambda/mcp-policy.js";
import { PERMIT_ANY_REMOTE } from "./helpers/mcp-policy-fixtures.js";
import { posterSetup } from "./helpers/poster-fixtures.js";

describe("poster get-mcp-policy", () => {
  it("returns the bundled global policy", async () => {
    const { poster } = await posterSetup({ globalMcpPolicy: PERMIT_ANY_REMOTE });

    expect(await poster({ operation: "get-mcp-policy" })).toEqual({ policy: PERMIT_ANY_REMOTE });
  });

  it("returns null when no policy is bundled", async () => {
    const { poster } = await posterSetup();

    expect(await poster({ operation: "get-mcp-policy" })).toEqual({ policy: null });
  });

  it("rejects extra fields", async () => {
    const { poster } = await posterSetup();

    await expect(poster({ operation: "get-mcp-policy", extra: "x" })).rejects.toThrow();
  });
});

describe("readBundledMcpPolicy", () => {
  const directoryUrl = async () => pathToFileURL(`${await mkdtemp(join(tmpdir(), "policy-"))}/`);

  it("reads the file next to the handler", async () => {
    const dir = await directoryUrl();
    await writeFile(new URL(BUNDLED_MCP_POLICY_FILE, dir), PERMIT_ANY_REMOTE);

    expect(await readBundledMcpPolicy(new URL(BUNDLED_MCP_POLICY_FILE, dir))()).toBe(
      PERMIT_ANY_REMOTE,
    );
  });

  it("is undefined when the file is absent", async () => {
    const dir = await directoryUrl();

    expect(await readBundledMcpPolicy(new URL(BUNDLED_MCP_POLICY_FILE, dir))()).toBeUndefined();
  });

  it("rethrows other read errors", async () => {
    const dir = await directoryUrl();

    await expect(readBundledMcpPolicy(dir)()).rejects.toThrow();
  });
});
