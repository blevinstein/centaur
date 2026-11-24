# Deploying

`infra/centaur.yml` is a standalone CloudFormation template (it imports nothing), and
`scripts/deploy.sh` bundles the Lambda, uploads it and deploys the stack. Personal values live in a
git-ignored parameters file.

## Prerequisites

- Node 24 and `yarn install --immutable` in this repo, plus `jq`, `zip` and the AWS CLI with
  credentials for the target account and region.

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
| `AttachmentExpirationDays` | Days before objects under `attachments/` expire. |
| `CodeExpirationDays` | Days before uploaded Lambda zips expire. |
| `OidcAudience` | Audience workflows request for the OIDC token they pass to register (default `centaur`). |
| `LogRetentionDays` | Days to keep Lambda logs. |
| `HistoryMaxMessages` | Newest messages kept per chat and per thread in stored history (Telegram), 1 to 5000, default 100. The state adapter reads the whole list on every append, so cost per message grows with it (see [chat-context.md](chat-context.md#what-the-platforms-can-provide)). Optional. |
| `HistoryTtlDays` | Days a stored history list lives after its latest message, 1 to 365, default 7. Optional. |

`CodeKey` and `DeployLambda` are set by the script.

## Usage

```sh
yarn deploy-prod
# equivalent to
scripts/deploy.sh --stack centaur --params-file parameters-prod.json
```

`Name=Value` arguments after the flags override the file, e.g. `scripts/deploy.sh --stack centaur
--params-file parameters-prod.json LogRetentionDays=7`. The same form sets the history window without touching the file, e.g.
`scripts/deploy.sh --stack centaur --params-file parameters-prod.json HistoryMaxMessages=500`.

The script:

1. Runs `yarn bundle:lambda` (esbuild bundles `src/lambda/handler.ts` and its dependencies into
   `dist/lambda/index.mjs`), zips it together with `infra/mcp-policy.cedar` when that file exists
   (the global MCP policy; see [mcp.md](mcp.md#operator-policy)), and names it `centaur/lambda-<sha256-prefix>.zip`. The
   content-addressed key makes each code change a new key, so the function updates.
2. If the stack does not exist (or has no `CodeBucketName` output), deploys it with
   `DeployLambda=FALSE`. That creates everything except the Lambda, its role, log group, function
   URL, `/centaur/function-url` parameter, and the GitHub role's `lambda:InvokeFunction` grant, so
   the stack-owned code bucket exists before any code is uploaded.
3. Uploads the zip to the stack's code bucket (the `CodeBucketName` output).
4. Deploys with `DeployLambda=TRUE` and the hashed `CodeKey`, then prints the stack outputs
   (code bucket, session bucket, table, role ARN, function name and ARN, function URL).

Later runs skip step 2. The code, session and state resources are retained if the stack is deleted.

State rows use the `@blevinstein/chat-state-dynamodb` key layout (`<keyPrefix>#<kind>#<id>`). Rows written by an
earlier layout (`<keyPrefix><kind>:<id>`) are never read and age out through TTL, except the
subscription and `registry:<bot>` rows, which had none. After the first deploy on the new layout,
rerun the register step (the `register` workflow job) for each bot to rewrite its `respond_to` entry; thread state, history and
pull request links of existing conversations start empty.

## Cost allocation tag

The script passes `--tags Business=$BUSINESS_TAG` (default `Centaur`), and CloudFormation applies
these stack-level tags to every resource that supports tags (the DynamoDB table, both S3 buckets,
the Lambda function, its log group and the IAM roles). Set `BUSINESS_TAG=...` to use another value.
Tags appear in Cost Explorer only after `Business` is activated as a cost allocation tag in the
Billing console (Cost allocation tags, user-defined), and not retroactively.

## Function URL and `FUNCTION_URL`

A function's environment can't reference its own function URL (the URL resource depends on the
function). The template instead publishes the URL as the SSM parameter `/centaur/function-url`,
which the poster reads at cold start to build webhook URLs; there is no `FUNCTION_URL` variable.

The template also publishes the state table's name (not its ARN) as `/centaur/state-table`, which
`centaur chat tail` reads when neither `--table` nor `CENTAUR_STATE_TABLE` is given. Unlike
`/centaur/function-url` it exists whether or not the Lambda is deployed.

## IAM

The function role gets the state table policy (`GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`,
`Query` and `DescribeTable` on the table, which `@blevinstein/chat-state-dynamodb` calls), log writes, `ssm:GetParametersByPath` on
`/centaur/bots` and `/centaur/chats`, `ssm:GetParameter` on `/centaur/github/token`, `/centaur/function-url`,
`/centaur/chats/*`, `/centaur/admin/*` and `/centaur/admin-claim/*`,
`ssm:PutParameter` only on `/centaur/bots/*/repo`, `/centaur/bots/*/approved-chats/*`,
`/centaur/bots/*/approved-users/*`, `/centaur/bots/*/blocked/*`, `/centaur/bots/*/platforms/*/approvers/*`, `/centaur/chats/*` and `/centaur/admin/*`,
`ssm:DeleteParameter` only on `/centaur/admin-claim/*` and `/centaur/bots/*/platforms/*/approvers/*`, and `kms:Decrypt` through SSM. The `/centaur/chats/*` write lets approvals create destinations and lets a persistent run bind a thread to one (the only overwrite; approvals never replace a destination, but IAM cannot condition on the `Overwrite` flag).
The GitHub OIDC role (assumable by repositories under `GitHubOwner`) can read and write objects
under `sessions/` in the session bucket and invoke the function.
The function URL is public (`AuthType NONE`) so Telegram and Slack can reach it.

After the first deploy, store secrets with the [CLI](cli.md) and register repos as described in
[onboarding](onboarding.md).
