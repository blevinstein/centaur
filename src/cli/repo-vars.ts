import { z } from "zod";

const stackSchema = z.object({
  StackId: z.string(),
  Outputs: z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() })).default([]),
  Parameters: z
    .array(z.object({ ParameterKey: z.string(), ParameterValue: z.string() }))
    .default([]),
});

/** The Actions variables the shared workflows read, derived from a `describe-stacks` stack. */
export function stackVariables(description: unknown): Record<string, string> {
  const stack = stackSchema.parse(description);
  const outputs = new Map(stack.Outputs.map((o) => [o.OutputKey, o.OutputValue]));
  const parameters = new Map(stack.Parameters.map((p) => [p.ParameterKey, p.ParameterValue]));
  const require = (values: Map<string, string>, key: string) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`the stack has no ${key}`);
    return value;
  };
  return {
    CENTAUR_ROLE_ARN: require(outputs, "RoleArn"),
    CENTAUR_AWS_REGION: stack.StackId.split(":")[3] ?? "",
    CENTAUR_FUNCTION_NAME: require(outputs, "FunctionName"),
    CENTAUR_OIDC_AUDIENCE: require(parameters, "OidcAudience"),
    CENTAUR_SESSION_BUCKET: require(outputs, "BucketName"),
  };
}
