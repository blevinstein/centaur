import { describe, expect, it } from "vitest";
import {
  approvalParameterFor,
  createApproveHarness,
  globalPolicyFile,
  SERVER_NAME,
  UNPINNED_SERVER_YAML,
} from "./helpers/mcp-approve-fixtures.js";
import {
  FORBID_UNLESS_GITHUB,
  PERMIT_ANY_PINNED,
  PERMIT_ANY_REMOTE,
} from "./helpers/mcp-policy-fixtures.js";

describe("mcp approve", () => {
  it("shows the definition and writes the approval record with --yes", async () => {
    const cli = await createApproveHarness();

    await cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes");

    const record = JSON.parse((await cli.store.get(cli.parameter)) as string);
    expect(record).toEqual({ at: expect.any(String), approver: "cli" });
    expect(cli.output[0]).toContain("command: npx");
    expect(cli.output[0]).toContain("args: -y @example/docs-mcp@1.4.2");
    expect(cli.output[0]).toContain("env: INDEX_URL, API_KEY (secret)");
    expect(cli.output[0]).toContain("pinned: yes");
    expect(cli.output[0]).not.toContain("docs.example.com");
  });

  it("writes nothing without --yes", async () => {
    const cli = await createApproveHarness();

    await expect(cli.run("mcp", "approve", "garden", SERVER_NAME)).rejects.toThrow("Pass --yes");

    expect(cli.store.entries.has(cli.parameter)).toBe(false);
    expect(cli.output[0]).toContain("command: npx");
  });

  it("keeps the first record when run again", async () => {
    const cli = await createApproveHarness();
    await cli.approveMcp("garden", SERVER_NAME, cli.parameter.split("/").at(-1) as string);
    const before = await cli.store.get(cli.parameter);

    await cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes");

    expect(await cli.store.get(cli.parameter)).toBe(before);
    expect(cli.output.at(-1)).toContain("Already approved");
  });

  it("approves the definition as it stands on the default branch", async () => {
    const edited = (await createApproveHarness()).parameter;
    const cli = await createApproveHarness({
      servers: UNPINNED_SERVER_YAML.replace("docs-mcp", "docs-mcp@2.0.0"),
    });

    await cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes");

    expect(cli.parameter).not.toBe(edited);
    expect(cli.store.entries.has(cli.parameter)).toBe(true);
    expect(cli.store.entries.has(edited)).toBe(false);
  });

  it("refuses a server that is not in mcp_servers", async () => {
    const cli = await createApproveHarness();

    await expect(cli.run("mcp", "approve", "garden", "other", "--yes")).rejects.toThrow(
      'Server "other" is not in mcp_servers',
    );
  });

  it("refuses an unpinned definition even when the policy permits it", async () => {
    const cli = await createApproveHarness({ servers: UNPINNED_SERVER_YAML });

    await expect(cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes")).rejects.toThrow(
      "not pinned",
    );

    expect(cli.store.entries.has(approvalParameterFor(UNPINNED_SERVER_YAML))).toBe(false);
  });

  it("refuses a definition the repo policy does not permit", async () => {
    const cli = await createApproveHarness({ policy: PERMIT_ANY_REMOTE });

    await expect(cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes")).rejects.toThrow(
      "violates the operator policy",
    );

    expect(cli.store.entries.has(cli.parameter)).toBe(false);
  });

  it("refuses a definition the --global-policy file forbids", async () => {
    const cli = await createApproveHarness();
    const globalPolicy = await globalPolicyFile(FORBID_UNLESS_GITHUB);

    await expect(
      cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes", "--global-policy", globalPolicy),
    ).rejects.toThrow("violates the operator policy");

    expect(cli.store.entries.has(cli.parameter)).toBe(false);
  });

  it("writes nothing for a server the policy allows without approval", async () => {
    const cli = await createApproveHarness({ policy: PERMIT_ANY_PINNED });

    await cli.run("mcp", "approve", "garden", SERVER_NAME, "--yes");

    expect(cli.output).toEqual([expect.stringContaining("nothing to approve")]);
    expect(cli.store.entries.has(cli.parameter)).toBe(false);
  });

  it("rejects an unknown bot and a bot without a repository", async () => {
    const cli = await createApproveHarness();
    await cli.connect("loose", "telegram");

    await expect(cli.run("mcp", "approve", "nope", SERVER_NAME, "--yes")).rejects.toThrow(
      'Unknown bot "nope"',
    );
    await expect(cli.run("mcp", "approve", "loose", SERVER_NAME, "--yes")).rejects.toThrow(
      "not bound to a repository",
    );
  });

  it("rejects a config that names another bot", async () => {
    const cli = await createApproveHarness();
    await cli.connect("other", "telegram");
    await cli.bind("other", cli.store.entries.get("/centaur/bots/garden/repo")?.value as string);

    await expect(cli.run("mcp", "approve", "other", SERVER_NAME, "--yes")).rejects.toThrow(
      'is for bot "garden"',
    );
  });
});
