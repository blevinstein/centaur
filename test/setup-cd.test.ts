import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createSetupCd,
  environmentJson,
  envPath,
  missing,
  ok,
  policiesJson,
  secretMarker,
  variablesJson,
} from "./helpers/setup-cd-fixtures.js";

const policiesPath = `${envPath}/deployment-branch-policies`;

describe("scripts/setup-cd.sh", () => {
  it("prints the commands and runs nothing with --dry-run", async () => {
    const cd = await createSetupCd();
    const environment = cd.run(["environment", "--dry-run"]);
    const credentials = cd.run(["credentials", "--dry-run"]);
    expect(environment.stdout).toContain("+ gh api -X PUT");
    expect(credentials.stdout).toContain("gh secret set DEPLOY_PARAMETERS");
    expect([environment.code, credentials.code]).toEqual([0, 0]);
    expect(await cd.calls()).toEqual([]);
  });

  it("creates the environment and policy when missing, then verifies", async () => {
    const cd = await createSetupCd();
    await cd.respond("gh", "api", envPath, missing, environmentJson);
    await cd.respond("gh", "api", policiesPath, policiesJson(), policiesJson("main"));
    const result = cd.run(["environment"]);
    const calls = await cd.calls();
    expect(result.code).toBe(0);
    expect(calls.filter((call) => call.startsWith(`gh api -X PUT ${envPath}`))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("gh api -X POST"))).toHaveLength(1);
  });

  it("changes nothing when the environment is already restricted to main", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    const first = cd.run(["environment"]);
    const second = cd.run(["environment"]);
    const mutations = (await cd.calls()).filter((call) => call.includes("-X "));
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(mutations).toEqual([]);
  });

  it("fails when the environment has an extra branch policy", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    await cd.respond("gh", "api", policiesPath, policiesJson("main", "dev"));
    const result = cd.run(["environment"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("not exactly [main]");
  });

  it("credentials refuses without the restricted environment", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    await cd.respond("gh", "api", envPath, missing);
    const result = cd.run(["credentials"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("environment");
    expect((await cd.calls()).some((call) => call.includes(" set "))).toBe(false);
  });

  it("credentials refuses without the DeployRoleArn output", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    await cd.respond("aws", "cloudformation", "describe-stacks", ok("None\n"));
    const result = cd.run(["credentials"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("DeployRoleArn");
  });

  it("credentials refuses without CENTAUR_AWS_REGION", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    await cd.respond("gh", "variable", "list", variablesJson("OTHER"));
    const result = cd.run(["credentials"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("CENTAUR_AWS_REGION");
    expect((await cd.calls()).some((call) => call.includes("variable set"))).toBe(false);
  });

  it("passes the secret on stdin and never on the command line", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    const result = cd.run(["credentials"]);
    const calls = await cd.calls();
    expect(result.code).toBe(0);
    expect(calls).toContain("gh secret set DEPLOY_PARAMETERS --repo o/r");
    expect(calls).toContain(
      "gh variable set DEPLOY_ROLE_ARN --repo o/r --body arn:aws:iam::1:role/centaur-DeployRole-x",
    );
    expect(await cd.stdin()).toContain(secretMarker);
    expect(calls.join("\n")).not.toContain(secretMarker);
    expect(result.stdout + result.stderr).not.toContain(secretMarker);
  });

  it("rejects a parameters file that is not an array of pairs", async () => {
    const cd = await createSetupCd();
    await cd.respondReady();
    await writeFile(cd.paramsFile, "{}");
    const result = cd.run(["credentials"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("JSON array");
    expect(await cd.calls()).toEqual([]);
  });

  it("check reports what is missing in step order", async () => {
    const cd = await createSetupCd();
    await cd.respond("gh", "api", envPath, missing);
    await cd.respond("aws", "cloudformation", "describe-stacks", missing);
    await cd.respond("gh", "variable", "list", variablesJson());
    await cd.respond("gh", "secret", "list", variablesJson());
    const result = cd.run(["check"]);
    expect(result.code).not.toBe(0);
    const order = ["1. environment", "3. first manual deploy", "4. variable CENTAUR_AWS_REGION"];
    const positions = order.map((item) => result.stdout.indexOf(item));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
