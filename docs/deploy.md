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
| `InspectionRolePrincipalArn` | IAM user or role ARN allowed to assume the inspection role (see [IAM](#iam)). Empty trusts the account. Optional. |
| `SessionExpirationDays` | Days before objects under `sessions/` expire. |
| `AttachmentExpirationDays` | Days before objects under `attachments/` expire. |
| `CodeExpirationDays` | Days before uploaded Lambda zips expire. |
| `OidcAudience` | Audience workflows request for the OIDC token they pass to register (default `centaur`). |
| `RequirePosterToken` | `true` or `false` (default `false`). When `true`, `post`, `unreact`, `start-thread` and `get-mcp-policy` reject a request without a valid OIDC token, and `post`, `unreact` and `start-thread` also reject a token from a repository the bot is not bound to (see [poster.md](poster.md#security-model)). Turn it on once every bound repo runs a workflow version that sends the token. Optional. |
| `LogRetentionDays` | Days to keep Lambda logs. |
| `HistoryMaxMessages` | Newest messages kept per chat and per thread in stored history (Telegram), 1 to 5000, default 100. The state adapter reads the whole list on every append, so cost per message grows with it (see [chat-context.md](chat-context.md#what-the-platforms-can-provide)). Optional. |
| `HistoryTtlDays` | Days a stored history list lives after its latest message, 1 to 365, default 7. Optional. |
| `DispatchFailureNoticeMinutes` | Minimum minutes between direct messages to a bot's admin about a failed GitHub dispatch, per bot, 0 to 1440, default 15; 0 turns the notice off. Optional. |

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
Likewise `DispatchFailureNoticeMinutes=0` disables the dispatch failure notice (see [plan.md](plan.md#receiver-lambda)).

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
The inspection role (`InspectionRoleArn` output) has no write permission: `GetItem`, `Query` and `Scan` on the state
table, `ssm:GetParameter`, `GetParameters` and `GetParametersByPath` on `/centaur/bots` and `/centaur/bots/*`,
and `kms:Decrypt` through SSM so SecureString values read back. That includes each bot's platform token and
signing or webhook secret: `centaur chat tail` reads the chat with the bot's own token and loads the
connection through the same path read, so those parameters cannot be denied without breaking it. Treat the
role like the secrets themselves. The admin claim codes and `/centaur/github/token` are outside its resources.
Use it instead of a broad IAM user for inspection and `centaur chat tail`. Its trust policy names
`InspectionRolePrincipalArn` or, when that is empty, the account root, which only lets identities that
already hold `sts:AssumeRole` on the role assume it; set the parameter to a single user or role to narrow it
(an account administrator can assume the role either way). Sessions last one hour.

```sh
creds=$(aws sts assume-role --role-arn <InspectionRoleArn> --role-session-name inspect \
  --query Credentials --output json)
export AWS_ACCESS_KEY_ID=$(jq -r .AccessKeyId <<<"$creds") \
  AWS_SECRET_ACCESS_KEY=$(jq -r .SecretAccessKey <<<"$creds") \
  AWS_SESSION_TOKEN=$(jq -r .SessionToken <<<"$creds")
```

The deploy role (`DeployRoleArn` output) is assumed only by the `production` environment of this repository's workflows; see [Continuous deployment](#continuous-deployment). Every role in the stack carries `DeployPolicy` as its permissions boundary.

The function URL is public (`AuthType NONE`) so Telegram and Slack can reach it.

After the first deploy, store secrets with the [CLI](cli.md) and register repos as described in
[onboarding](onboarding.md).

## Continuous deployment

`.github/workflows/deploy.yml` deploys the stack on every push to `main` and on manual dispatch.
`.github/workflows/ci.yml` (`yarn verify` and `yarn lint:cfn`) runs on pull requests and, for
pushes to `main`, as the first job of the Deploy workflow (`verify`, which has no path filter, so a
docs-only push is checked once too); the `deploy` job runs only if it passes.

The `deploy` job:

1. Runs in the GitHub `production` environment, one at a time (`concurrency: deploy-prod`, queued
   rather than cancelled).
2. Refuses a commit that is not an ancestor of `origin/main`, so a dispatch cannot deploy an
   unmerged branch.
3. Assumes `DeployRole` through GitHub OIDC (repository variable `DEPLOY_ROLE_ARN`, region from
   `CENTAUR_AWS_REGION`).
4. Writes the repository secret `DEPLOY_PARAMETERS` (the contents of `parameters-prod.json`) to a
   mode 600 `parameters-prod.json`, masks its longer values, runs `yarn deploy-prod` and deletes the
   file.

Bots that push to `main` with `GITHUB_TOKEN` do not trigger it, so only pushes by people (and
merges) deploy. To redeploy or roll back, run the `Deploy` workflow with `ref` set to a commit,
tag or branch that is already on `main`:

```sh
gh workflow run deploy.yml -f ref=<sha>
```

Each Lambda zip is stored under a content-addressed key in the code bucket until
`CodeExpirationDays` passes, and the deploy rebuilds the bundle from the chosen ref, so deploying an
older ref restores the older code with no extra step. Template changes in the older ref are
deployed with it.

### What the deploy role can change

On roles named `<stack>-*`, `DeployPolicy` grants `iam:CreateRole`, `PutRolePolicy`,
`DeleteRolePolicy`, `DetachRolePolicy` and `AttachRolePolicy` (all only for roles carrying
`DeployPolicy` as their permissions boundary), plus `GetRole`, `GetRolePolicy`, `ListRolePolicies`,
`ListAttachedRolePolicies`, `ListInstanceProfilesForRole`, `UpdateRole`, `UpdateAssumeRolePolicy`,
`DeleteRole`, `TagRole` and `UntagRole`. It does not grant `iam:UpdateRoleDescription` or the
permissions-boundary actions, so changing the `Description` (or boundary) of any role in this stack
fails the CD update, and the rollback fails for the same reason, leaving the stack in
`UPDATE_ROLLBACK_FAILED`. Deploy such a change by hand with admin credentials (`yarn deploy-prod`).
To recover a stuck stack, skip the failed resources:

```sh
aws cloudformation continue-update-rollback --stack-name centaur \
  --resources-to-skip InspectionRole ReceiverFunction
```

List every resource the stack's status reason names
(`aws cloudformation describe-stacks --stack-name centaur --query 'Stacks[0].StackStatusReason'`);
`aws cloudformation describe-stack-resources --stack-name centaur` shows which ones are stuck.

### One-time setup

`scripts/setup-cd.sh` does the GitHub side (needs `gh` with admin on the repository, `aws` and `jq`;
`--repo`, `--stack`, `--params-file` and `--dry-run` are accepted by every subcommand, and
`--dry-run` prints the commands without running anything).

Order matters: the role's trust accepts any token whose subject is the `production` environment,
and GitHub creates a missing environment, unrestricted, the first time a workflow references it.
Restrict the environment before the role exists.

1. `scripts/setup-cd.sh environment` creates the `production` environment limited to `main`, before
   merging or pushing this change. It is idempotent and verifies the result.
2. Merge and push. The first push runs CI; the `deploy` job fails harmlessly at the credentials
   step because `DEPLOY_ROLE_ARN` is not set yet.
3. From the merged commit, deploy by hand with admin credentials, which creates the role:
   `yarn deploy-prod`. Review the change set (the existing roles gain `PermissionsBoundary`) and
   check afterwards that the Lambda still reaches its table, bucket and parameters for every bot.
4. `scripts/setup-cd.sh credentials` reads the `DeployRoleArn` output, re-verifies the environment
   (it refuses otherwise), requires the `CENTAUR_AWS_REGION` repository variable, sets the
   `DEPLOY_ROLE_ARN` variable and sets the `DEPLOY_PARAMETERS` secret from `jq -c . parameters-prod.json`
   on stdin (minified: GitHub masks a multi-line secret line by line).
5. Run the `Deploy` workflow (`gh workflow run deploy.yml`) to confirm it assumes the role.

`scripts/setup-cd.sh check` shows what is done and what is still missing, in step order.

Branch protection on `main` (pull requests and the pull request `verify` check, which GitHub lists under CI; the deploy path
reports `verify / verify` instead and must not be the required one) is recommended but a separate,
manual decision: requiring pull requests also stops direct pushes to `main`, including the
direct-execution-mode bots' pushes. To require approval before each deploy, add required reviewers
to the `production` environment; nothing else changes.

<details>
<summary>What the script runs</summary>

```sh
# environment (skipped when already restricted to main)
gh api -X PUT repos/<owner>/<repo>/environments/production \
  --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST repos/<owner>/<repo>/environments/production/deployment-branch-policies \
  -f name=main -f type=branch

# credentials
role_arn=$(aws cloudformation describe-stacks --stack-name centaur \
  --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)
gh variable set DEPLOY_ROLE_ARN --repo <owner>/<repo> --body "$role_arn"
jq -c . parameters-prod.json | gh secret set DEPLOY_PARAMETERS --repo <owner>/<repo>
```

</details>

### Threat model

An unrestricted `production` environment is how the role's trust is bypassed: with it, a workflow on any branch by anyone with write access can obtain the credentials. Setup step 1 is not optional.

Anyone who can get a commit onto `main` can change what the deploy runs: the workflow, the build
scripts and the template all come from the pushed commit. The controls are:

- The role's trust accepts only the `production` environment of this repository under the
  configured owner, and the environment accepts only `main`. A pull request, a fork or another
  branch cannot obtain the credentials. The workflow also refuses unmerged refs. This repository
  uses immutable OIDC subjects, which carry the owner and repository ids
  (`repo:<owner>@<ownerId>/centaur@<repoId>:environment:production`). The template does not know
  the repository id, so the trust pins the owner id, the repository name and the environment and
  matches the repository id with a wildcard. The legacy name form without ids is also accepted.
  All subjects sit in one `StringLike` list, since IAM combines different condition operators with
  AND; the audience stays an exact `StringEquals`.
- `DeployPolicy` limits the role to this stack's resources (names built from the stack name). IAM
  actions are limited to roles and policies with the stack's name prefix, and role changes are only
  allowed on roles carrying `DeployPolicy` as their permissions boundary. `DeployPolicy` is that
  boundary for every role in the stack (including `DeployRole`) and is also the deploy role's whole
  permission set, so no role the deploy creates or edits can exceed it, and it cannot attach a
  policy from outside the stack prefix.
- `DeployPolicy` explicitly denies the deploy role from changing `DeployRole` (trust, policies,
  boundary, deletion) and from creating, editing or deleting a version of `DeployPolicy`. A commit
  that edits those fails the deploy and CloudFormation rolls back. They change only through a
  manual `yarn deploy-prod` with admin credentials.

Residual risk: a commit on `main` can still do anything `DeployPolicy` allows within the stack:
replace the Lambda code (which can read and write the state table, the session and code buckets
and `/centaur/*` parameters, including secrets, through the function role), widen the function URL,
or change other roles inside the boundary. The role also holds that data access itself, because one
document serves as both the ceiling and the deploy permissions. Treat write access to `main` as
equivalent to administering the Centaur stack, require reviews on `main` and consider required
reviewers on the `production` environment.

Claim names that GitHub documents beyond `aud` and `sub` (for example `job_workflow_ref`) are not
used as IAM conditions; the environment plus the environment's branch restriction cover the same
ground. The `sub` format was checked against the repository's OIDC customization endpoint
(`gh api repos/<owner>/<repo>/actions/oidc/customization/sub`, which `scripts/setup-cd.sh check`
prints); the first real token is the final proof. If a run fails with `Not authorized to perform
sts:AssumeRoleWithWebIdentity`, compare the token's `sub` with the role's trust policy.

`DeployRole` cannot change its own trust, so a change to the trust (such as the subject format)
takes effect only through a manual `yarn deploy-prod` with admin credentials.

### Lockout

The deploy role updates its own stack, so a template that breaks it can strand later deploys:
removing an action from `DeployPolicy` that a later deploy needs, a boundary that no longer covers a
role's permissions (the Lambda then fails at runtime although the deploy succeeds), or a failed
update that leaves the stack in `UPDATE_ROLLBACK_FAILED`. The frozen statements above make the
destructive cases fail the deploy rather than apply. Recovery is a manual deploy with admin
credentials from a known-good commit:

```sh
git switch --detach <good-sha>
yarn deploy-prod
```

If the stack is stuck in `UPDATE_ROLLBACK_FAILED`, continue the rollback in the CloudFormation
console (or `aws cloudformation continue-update-rollback`) before redeploying.

Changing `DeployPolicy`, `DeployRole` or any role's boundary, and adding an AWS service to the
template, requires a manual deploy first, because the deploy role cannot grant itself new
permissions. `DeployPolicy` is capped at 6144 characters (IAM's managed policy limit), so the
policy may need to be split when the stack grows.
