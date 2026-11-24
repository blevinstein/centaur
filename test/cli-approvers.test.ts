import { describe, expect, it } from "vitest";
import { MAX_APPROVERS } from "../src/lambda/approvers.js";
import { approverPath, createApproverHarness, createCliHarness } from "./helpers/cli.js";

describe("approvers add", () => {
  it("writes an entry with the time and no approver", async () => {
    const cli = await createApproverHarness();

    await cli.run("approvers", "add", "garden", "6001");

    expect(cli.output.at(-1)).toBe('Added approver 6001 for bot "garden".');
    expect(JSON.parse((await cli.store.get(approverPath("6001"))) ?? "")).toEqual({
      at: expect.stringMatching(/^\d{4}-/),
    });
    expect(cli.store.entries.get(approverPath("6001"))?.secure).toBe(false);
  });

  it("keeps the original entry when re-added", async () => {
    const cli = await createApproverHarness();
    await cli.addApprover("garden", "telegram", "6001");

    await cli.run("approvers", "add", "garden", "6001");

    expect(cli.output.at(-1)).toBe('6001 is already an approver for bot "garden".');
    expect(await cli.store.get(approverPath("6001"))).toBe("{}");
  });

  it("refuses without an admin", async () => {
    const cli = createCliHarness();
    await cli.connect("garden", "telegram");

    await expect(cli.run("approvers", "add", "garden", "6001")).rejects.toThrow(
      /No admin is set for telegram/,
    );
    expect(cli.store.names()).not.toContain(approverPath("6001"));
  });

  it("refuses the admin's own ID", async () => {
    const cli = await createApproverHarness();

    await expect(cli.run("approvers", "add", "garden", "5001")).rejects.toThrow(/is the admin/);
    expect(cli.store.names()).not.toContain(approverPath("5001"));
  });

  it("refuses over the cap but still accepts a re-add at it", async () => {
    const cli = await createApproverHarness();
    const ids = Array.from({ length: MAX_APPROVERS }, (_, index) => `${6000 + index}`);
    for (const id of ids) await cli.addApprover("garden", "telegram", id);

    await expect(cli.run("approvers", "add", "garden", "7000")).rejects.toThrow(
      new RegExp(`already has ${MAX_APPROVERS} approvers`),
    );
    expect(cli.store.names()).not.toContain(approverPath("7000"));
    await cli.run("approvers", "add", "garden", ids[0] as string);
    expect(cli.output.at(-1)).toMatch(/already an approver/);
  });
});

describe("approvers remove", () => {
  it("deletes only that approver", async () => {
    const cli = await createApproverHarness();
    await cli.addApprover("garden", "telegram", "6001");
    await cli.addApprover("garden", "telegram", "6002");
    await cli.addApprover("garden", "slack", "6001");
    await cli.addApprover("other", "telegram", "6001");

    await cli.run("approvers", "remove", "garden", "6001");

    expect(cli.output.at(-1)).toBe('Removed approver 6001 for bot "garden".');
    expect(cli.store.names().filter((name) => name.includes("/approvers/"))).toEqual([
      approverPath("6001", "slack"),
      approverPath("6002"),
      approverPath("6001", "telegram", "other"),
    ]);
  });

  it("errors on an unknown ID and deletes nothing", async () => {
    const cli = await createApproverHarness();
    await cli.addApprover("garden", "telegram", "6001");
    const before = cli.store.names();

    await expect(cli.run("approvers", "remove", "garden", "6009")).rejects.toThrow(
      /Approver 6009 not found/,
    );
    expect(cli.store.names()).toEqual(before);
  });
});

describe("approvers list", () => {
  it("says there are none and shows the admin", async () => {
    const cli = await createApproverHarness();

    await cli.run("approvers", "list", "garden");

    expect(cli.output.at(-1)).toBe(
      'No approvers for "garden" on telegram.\nThe admin (5001) is always an approver.',
    );
  });

  it("shows none for an unclaimed admin", async () => {
    const cli = createCliHarness();
    await cli.connect("garden", "telegram");

    await cli.run("approvers", "list", "garden");

    expect(cli.output.at(-1)).toMatch(/The admin \(none\) is always an approver\.$/);
  });

  it("lists each approver in order with its time and who added it", async () => {
    const cli = await createApproverHarness();
    await cli.run("approvers", "add", "garden", "6002");
    await cli.addApprover("garden", "telegram", "6001", "5001");

    await cli.run("approvers", "list", "garden");

    expect(cli.output.at(-1)).toMatch(
      /^6001 {2}2026-01-02T03:04:05\.000Z {2}added by 5001\n6002 {2}\d{4}-\S+ {2}added by the CLI\nThe admin \(5001\) is always an approver\.$/,
    );
  });
});

describe("--platform", () => {
  it("is required with several connections and selects the connection", async () => {
    const cli = await createApproverHarness(["telegram", "slack"]);

    await expect(cli.run("approvers", "add", "garden", "U2")).rejects.toThrow(/pass --platform/);
    await cli.run("approvers", "add", "garden", "U2", "--platform", "slack");
    await cli.run("approvers", "list", "garden", "--platform", "telegram");

    expect(cli.store.names()).toContain(approverPath("U2", "slack"));
    expect(cli.store.names()).not.toContain(approverPath("U2"));
    expect(cli.output.at(-1)).toMatch(/^No approvers for "garden" on telegram/);
  });

  it("checks the admin of the selected platform", async () => {
    const cli = await createApproverHarness(["telegram", "slack"]);
    await cli.run("admin", "remove", "--slack");

    await expect(
      cli.run("approvers", "add", "garden", "U2", "--platform", "slack"),
    ).rejects.toThrow(/No admin is set for slack/);
  });
});
