# Deploying

`infra/centaur.yml` is a standalone CloudFormation template (it imports nothing), and
`scripts/deploy.sh` bundles the Lambda, uploads it and deploys the stack. Personal values live in a
git-ignored parameters file.

## Prerequisites

- Node 24 and `npm ci` in this repo, plus `jq`, `zip` and the AWS CLI with credentials for the
  target account and region.

## Parameters file

Copy `parameters.example.json` to `parameters-prod.json` (any `parameters-*.json` is git-ignored)
and fill it in. The file is a JSON array of `{ParameterKey, ParameterValue}` objects, the same
format `aws cloudformation` accepts.

| Parameter | Value |
| --- | --- |
| `GitHubOwner` | GitHub user or org whose repositories may assume the OIDC role. |
| `GitHubOwnerId` | Numeric id of that owner: `gh api users/<owner> --jq .id`. |
| `ExistingOidcProviderArn` | ARN of the account's existing `token.actions.githubusercontent.com` IAM OIDC provider (`aws iam list-open-id-connect-providers`), or empty to create one. An account can have only one. |
| `SessionExpirationDays` | Days before objects under `sessions/` expire. |
| `CodeExpirationDays` | Days before uploaded Lambda zips expire. |
| `OidcAudience` | Audience workflows request for the OIDC token they pass to register (default `centaur`). |
| `LogRetentionDays` | Days to keep Lambda logs. |

`CodeKey` and `DeployLambda` are set by the script.

## Usage

```sh
npm run deploy-prod
# equivalent to
scripts/deploy.sh --stack centaur --params-file parameters-prod.json
```

`Name=Value` arguments after the flags override the file, e.g. `scripts/deploy.sh --stack centaur
--params-file parameters-prod.json LogRetentionDays=7`.

The script:

1. Runs `npm run bundle:lambda` (esbuild bundles `src/lambda/handler.ts` and its dependencies into
   `dist/lambda/index.mjs`), zips it, and names it `centaur/lambda-<sha256-prefix>.zip`. The
   content-addressed key makes each code change a new key, so the function updates.
2. If the stack does not exist (or has no `CodeBucketName` output), deploys it with
   `DeployLambda=FALSE`. That creates everything except the Lambda, its role, log group, function
   URL, `/centaur/function-url` parameter, and the GitHub role's `lambda:InvokeFunction` grant, so
   the stack-owned code bucket exists before any code is uploaded.
3. Uploads the zip to the stack's code bucket (the `CodeBucketName` output).
4. Deploys with `DeployLambda=TRUE` and the hashed `CodeKey`, then prints the stack outputs
   (code bucket, session bucket, table, role ARN, function name and ARN, function URL).

Later runs skip step 2. The code, session and state resources are retained if the stack is deleted.

## Function URL and `FUNCTION_URL`

A function's environment can't reference its own function URL (the URL resource depends on the
function). The template instead publishes the URL as the SSM parameter `/centaur/function-url`,
which the poster reads at cold start to build webhook URLs; there is no `FUNCTION_URL` variable.

## IAM

The function role gets the state table policy, log writes, `ssm:GetParametersByPath` on
`/centaur/bots` and `/centaur/chats`, `ssm:GetParameter` on `/centaur/github/token`, `/centaur/function-url`,
`/centaur/chats/*`, `/centaur/admin/*` and `/centaur/admin-claim/*`,
`ssm:PutParameter` only on `/centaur/bots/*/repo`, `/centaur/bots/*/approved-chats/*`,
`/centaur/bots/*/approved-users/*`, `/centaur/bots/*/blocked/*`, `/centaur/chats/*` and `/centaur/admin/*`,
`ssm:DeleteParameter` only on `/centaur/admin-claim/*`, and `kms:Decrypt` through SSM. The `/centaur/chats/*` write lets approvals create chat aliases; the code never overwrites one, since IAM cannot condition on the `Overwrite` flag. The GitHub OIDC role may call `lambda:InvokeFunction` on the function.
The function URL is public (`AuthType NONE`) so Telegram and Slack can reach it.

After the first deploy, store secrets with the [CLI](cli.md) and register repos as described in
[onboarding](onboarding.md).
