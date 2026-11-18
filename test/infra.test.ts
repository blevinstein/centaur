import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Statement {
  Action: string | string[];
  Resource: string | string[];
}

const template = parse(readFileSync("infra/centaur.yml", "utf8"), {
  customTags: ["Sub", "Ref", "GetAtt", "If", "Equals", "Not", "Join", "Select"].map((tag) => ({
    tag: `!${tag}`,
    resolve: (value: string) => value,
  })),
  logLevel: "silent",
});

const parameterStatements: Statement[] = template.Resources.FunctionRole.Properties.Policies.find(
  (policy: { PolicyName: string }) => policy.PolicyName === "parameters",
).PolicyDocument.Statement;

const resourcesFor = (action: string) =>
  parameterStatements
    .filter((statement) => [statement.Action].flat().includes(action))
    .flatMap((statement) => [statement.Resource].flat())
    .map((arn) => arn.replace(/^.*:parameter/, ""));

describe("the Lambda role's parameter permissions", () => {
  it("can create chat aliases, and only under /centaur/chats", () => {
    expect(resourcesFor("ssm:PutParameter")).toContain("/centaur/chats/*");
    expect(resourcesFor("ssm:PutParameter").filter((name) => name.includes("chats"))).toEqual([
      "/centaur/bots/*/approved-chats/*",
      "/centaur/chats/*",
    ]);
  });

  it("can read chat aliases individually and by path", () => {
    expect(resourcesFor("ssm:GetParameter")).toContain("/centaur/chats/*");
    expect(resourcesFor("ssm:GetParametersByPath")).toEqual(
      expect.arrayContaining(["/centaur/chats", "/centaur/chats/*"]),
    );
  });

  it("no longer reads user aliases", () => {
    const all = parameterStatements.flatMap((statement) => [statement.Resource].flat());
    expect(all.filter((arn) => arn.includes("/users"))).toEqual([]);
  });

  it("cannot delete anything but admin claims", () => {
    expect(resourcesFor("ssm:DeleteParameter")).toEqual(["/centaur/admin-claim/*"]);
  });
});

const policyStatements = (role: string, policyName: string): Statement[] =>
  template.Resources[role].Properties.Policies.find(
    (policy: { PolicyName: string }) => policy.PolicyName === policyName,
  ).PolicyDocument.Statement;

describe("attachment storage", () => {
  it("lets the Lambda write, but not read or delete, objects under attachments/", () => {
    const actions = policyStatements("FunctionRole", "attachments").flatMap((s) =>
      [s.Action].flat(),
    );
    expect(actions).toEqual(["s3:PutObject", "s3:ListBucket"]);
  });

  it("lets the workflow role read attachments/ and nothing more than before under sessions/", () => {
    const statements = policyStatements("GitHubRole", "session-objects");
    const reads = statements.filter((s) => [s.Action].flat().includes("s3:GetObject"));
    expect(reads.map((s) => String(s.Resource).replace(/^.*\}\//, ""))).toEqual([
      "sessions/*",
      "attachments/*",
    ]);
  });

  it("expires attachments on their own schedule", () => {
    const rules = template.Resources.SessionBucket.Properties.LifecycleConfiguration.Rules;
    expect(rules.map((rule: { Prefix: string }) => rule.Prefix)).toEqual([
      "sessions/",
      "attachments/",
    ]);
  });

  it("tells the Lambda which bucket to use", () => {
    expect(template.Resources.ReceiverFunction.Properties.Environment.Variables).toHaveProperty(
      "SESSION_BUCKET_NAME",
    );
  });
});
