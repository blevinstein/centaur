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
