import { describe, expect, it } from "vitest";
import { createCliHarness } from "./helpers/cli.js";
import { EXPECTED_VARIABLES, fakeExec, STACK } from "./helpers/repo-vars-fixtures.js";

const setArgs = (name: string, value: string, ...target: string[]) => [
  "variable",
  "set",
  name,
  "--body",
  value,
  ...target,
];

describe("repo vars", () => {
  it("sets each variable on the repo of the current directory", async () => {
    const fake = fakeExec();
    const cli = createCliHarness({}, undefined, undefined, undefined, fake.exec);

    await cli.run("repo", "vars");

    expect(fake.setCalls()).toEqual(
      Object.entries(EXPECTED_VARIABLES).map(([name, value]) =>
        setArgs(name, value, "--repo", "me/garden"),
      ),
    );
    expect(fake.calls[1]?.[1]).toContain("centaur");
    expect(cli.output).toContain("CENTAUR_AWS_REGION=us-west-2");
  });

  it("targets an explicit repo or an organization without detecting the repo", async () => {
    const fake = fakeExec(STACK, "");
    const cli = createCliHarness({}, undefined, undefined, undefined, fake.exec);

    await cli.run("repo", "vars", "--repo", "me/other", "--stack", "prod");
    await cli.run("repo", "vars", "--org", "acme");

    const targets = fake.setCalls().map((args) => args.slice(5));
    expect(targets.slice(0, 5)).toEqual(Array(5).fill(["--repo", "me/other"]));
    expect(targets.slice(5)).toEqual(Array(5).fill(["--org", "acme", "--visibility", "all"]));
    expect(fake.calls[0]?.[1]).toContain("prod");
  });

  it("prints the variables and sets nothing with --dry-run", async () => {
    const fake = fakeExec();
    const cli = createCliHarness({}, undefined, undefined, undefined, fake.exec);

    await cli.run("repo", "vars", "--dry-run");

    expect(fake.setCalls()).toEqual([]);
    expect(cli.output).toHaveLength(5);
  });

  it("rejects --repo with --org", async () => {
    const cli = createCliHarness({}, undefined, undefined, undefined, fakeExec().exec);

    await expect(cli.run("repo", "vars", "--repo", "a/b", "--org", "c")).rejects.toThrow(
      /not both/,
    );
  });

  it("asks for --repo outside a GitHub repository", async () => {
    const cli = createCliHarness({}, undefined, undefined, undefined, fakeExec(STACK, "").exec);

    await expect(cli.run("repo", "vars")).rejects.toThrow(/pass --repo or --org/);
  });

  it("fails when the stack is not a Centaur stack", async () => {
    const stack = { ...STACK, Outputs: [] };
    const cli = createCliHarness({}, undefined, undefined, undefined, fakeExec(stack).exec);

    await expect(cli.run("repo", "vars")).rejects.toThrow(/not a Centaur stack.*RoleArn/);
  });
});
