import { readFileSync } from "node:fs";
import { TABLE_DEFINITION, TTL_ATTRIBUTE } from "@blevinstein/chat-state-dynamodb";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TTL_DAYS,
  HISTORY_MAX_MESSAGES_LIMIT,
  HISTORY_TTL_DAYS_LIMIT,
} from "../src/lambda/history-window.js";
import { STATE_TABLE_PARAMETER } from "../src/lambda/parameters.js";

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

  it.each([
    "/centaur/bots/garden/platforms/telegram/approved-chats/-100500",
    "/centaur/bots/garden/platforms/slack/approved-users/U1",
    "/centaur/bots/garden/platforms/slack/blocked/chat/C1",
    "/centaur/bots/garden/mcp-approvals/linear/0123456789abcdef",
  ])("can write the access entry or MCP approval %s", (name) => {
    const covers = (pattern: string) => new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(name);
    expect(resourcesFor("ssm:PutParameter").some(covers)).toBe(true);
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

describe("the state table", () => {
  const { StateTable, StateTableAccessPolicy } = template.Resources;

  it("has the schema and TTL attribute the state adapter expects", () => {
    const { AttributeDefinitions, KeySchema, BillingMode } = StateTable.Properties;
    expect({ AttributeDefinitions, KeySchema, BillingMode }).toEqual(TABLE_DEFINITION);
    expect(StateTable.Properties.TimeToLiveSpecification).toEqual({
      AttributeName: TTL_ATTRIBUTE,
      Enabled: true,
    });
  });

  it("publishes its name, not its ARN, as the SSM parameter the CLI reads", () => {
    expect(template.Resources.StateTableParameter).toEqual({
      Type: "AWS::SSM::Parameter",
      Properties: { Name: STATE_TABLE_PARAMETER, Type: "String", Value: "StateTable" },
    });
  });

  it("grants every action the state adapter calls", () => {
    expect(StateTableAccessPolicy.Properties.PolicyDocument.Statement[0].Action.sort()).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
  });
});

describe("the stored-history window", () => {
  it("has template parameters that match the code's defaults and bounds", () => {
    expect(template.Parameters.HistoryMaxMessages).toMatchObject({
      Default: DEFAULT_HISTORY_MAX_MESSAGES,
      MinValue: 1,
      MaxValue: HISTORY_MAX_MESSAGES_LIMIT,
    });
    expect(template.Parameters.HistoryTtlDays).toMatchObject({
      Default: DEFAULT_HISTORY_TTL_DAYS,
      MinValue: 1,
      MaxValue: HISTORY_TTL_DAYS_LIMIT,
    });
  });

  it("is passed to the Lambda through its environment", () => {
    expect(template.Resources.ReceiverFunction.Properties.Environment.Variables).toMatchObject({
      HISTORY_MAX_MESSAGES: "HistoryMaxMessages",
      HISTORY_TTL_DAYS: "HistoryTtlDays",
    });
  });
});
