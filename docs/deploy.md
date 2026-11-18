# Deploying

`infra/centaur.yml` is a standalone CloudFormation template (it imports nothing), and
`scripts/deploy.sh` bundles the Lambda, uploads it and deploys the stack. Personal values are
passed by the caller, typically from a private infra repo.

## Prerequisites

- Node 24 and `npm ci` in this repo, plus `zip` and the AWS CLI with credentials for the target
  account and region.
- An existing S3 bucket for Lambda code (not the stack's session bucket, which the stack creates).

## Usage

```sh
scripts/deploy.sh --stack centaur --code-bucket my-code-bucket \
  --params-file centaur.params GitHubOwner=my-org
```

- `--params-file` holds one `Name=Value` CloudFormation parameter override per line (blank lines
  and `#` comments are skipped). `Name=Value` arguments are applied after the file.
- Required template parameters: `GitHubOwner`, `GitHubOwnerId`. Optional: `ExistingOidcProviderArn`,
  `SessionExpirationDays`, `OidcAudience` (default `centaur`), `LogRetentionDays`.
- `CodeBucket` and `CodeKey` are set by the script.

The script runs `npm run bundle:lambda` (esbuild bundles `src/lambda/handler.ts` and its
dependencies into `dist/lambda/index.mjs`), zips it, uploads it to
`s3://<code-bucket>/centaur/lambda-<sha256-prefix>.zip`, runs `aws cloudformation deploy`, and
prints the stack outputs (function name and ARN, function URL, role ARN, bucket, table).
The content-addressed key makes each code change a new key, so the function updates.

## Function URL and `FUNCTION_URL`

A function's environment can't reference its own function URL (the URL resource depends on the
function). The template instead publishes the URL as the SSM parameter `/centaur/function-url`,
which the poster reads at cold start to build webhook URLs; there is no `FUNCTION_URL` variable.

## IAM

The function role gets the state table policy, log writes, `ssm:GetParametersByPath` on
`/centaur/bots`, `ssm:GetParameter` on `/centaur/github/token`, `/centaur/function-url`,
`/centaur/users/*` and `/centaur/chats/*`, `ssm:PutParameter` only on `/centaur/bots/*/repo`, and
`kms:Decrypt` through SSM. The GitHub OIDC role may call `lambda:InvokeFunction` on the function.
The function URL is public (`AuthType NONE`) so Telegram and Slack can reach it.

After the first deploy, store secrets with the [CLI](cli.md) and register repos as described in
[onboarding](onboarding.md).
