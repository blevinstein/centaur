import { readFileSync } from "node:fs";
import { parse } from "yaml";

interface Statement {
  Action: string | string[];
  Resource: string | string[];
}

export const template = parse(readFileSync("infra/centaur.yml", "utf8"), {
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

/** Whether the Lambda role's IAM policy allows `action` on the SSM parameter `name`; `*` spans slashes, as in IAM. */
export const lambdaMayOnParameter = (action: string, name: string) =>
  resourcesFor(action).some((pattern) =>
    new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(name),
  );
