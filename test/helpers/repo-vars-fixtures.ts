import type { Exec } from "../../src/workflows/aws.js";

export const STACK = {
  StackId: "arn:aws:cloudformation:us-west-2:123456789012:stack/centaur/abc",
  Outputs: [
    { OutputKey: "RoleArn", OutputValue: "arn:aws:iam::123456789012:role/centaur" },
    { OutputKey: "BucketName", OutputValue: "centaur-sessions" },
    { OutputKey: "FunctionName", OutputValue: "centaur-fn" },
  ],
  Parameters: [{ ParameterKey: "OidcAudience", ParameterValue: "centaur-aud" }],
};

export const EXPECTED_VARIABLES = {
  CENTAUR_ROLE_ARN: "arn:aws:iam::123456789012:role/centaur",
  CENTAUR_AWS_REGION: "us-west-2",
  CENTAUR_FUNCTION_NAME: "centaur-fn",
  CENTAUR_OIDC_AUDIENCE: "centaur-aud",
  CENTAUR_SESSION_BUCKET: "centaur-sessions",
};

/** An `Exec` that answers `aws` and `gh repo view` from fixtures and records every call. */
export function fakeExec(stack: unknown = STACK, currentRepo = "me/garden") {
  const calls: [string, string[]][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, args]);
    if (file === "aws") return JSON.stringify(stack);
    if (args[0] === "repo") {
      if (!currentRepo) throw new Error("not a git repository");
      return `${currentRepo}\n`;
    }
    return "";
  };
  const setCalls = () => calls.filter(([, args]) => args[0] === "variable").map(([, args]) => args);
  return { exec, calls, setCalls };
}
