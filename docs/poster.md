# Poster operations

The poster is the same Lambda function as the receiver, entered by direct invocation
(`aws lambda invoke`, authorized by IAM through the GitHub OIDC role). The function URL stays
public for webhooks; the handler treats any event with an `operation` key as a poster request and
everything else as a webhook. See [plan.md](plan.md#poster-lambda) for where it fits.

Requests are JSON objects validated strictly (unknown keys are errors). A failure surfaces as a
Lambda `FunctionError` whose payload carries the message. Bots must be fully configured and bound
to a repo (secrets plus `bots/<bot>/repo`) for every operation except `register`.

| `operation` | Fields | Result |
|---|---|---|
| `post` | `bot`, `threadId`, `text` | `{ messageId }` |
| `start-thread` | `bot`, `text`, optional `title` | `{ threadId }` |
| `read` | `bot`, `threadId` | `{ messages: [{ id, userId, userName, fromBot, text, sentAt }] }`, oldest first |
| `register` | `token` (GitHub OIDC JWT), `config` (`.centaur.yml` text) | `{ bot, repo }` |

All thread operations go through the bot's own Chat instance and state prefix (`bot:<bot>:`), so
the bot's posts land in the stored transcript the receiver and `read` use.

## `start-thread`

The destination chat is the bot's registered `destination` (registry entry, then
`/centaur/chats/<destination>`).

- **Telegram:** `createForumTopic` in the destination supergroup (the bot needs the Manage Topics
  admin right), named `title` or the first line of `text` (at most 128 characters), then `text` is
  posted into the topic. Thread ID is `telegram:<chatId>:<topicId>`.
- **Slack:** `text` is posted as a new top-level message in the destination channel; `title` is
  ignored. Thread ID is the new message's thread.

The thread is marked `createdByBot` (`BOT_CREATED_STATE` in `src/lambda/ownership.ts`) so the
receiver's ownership rule accepts human replies in it.

## `register`

The workflow sends the JWT from the GitHub Actions OIDC endpoint, requested with the audience
configured below. The Lambda verifies the signature against GitHub's JWKS, the issuer, the
audience and expiry, and requires `repository_owner` (and the owner half of `repository`) to equal
the configured owner. The repo name comes only from the verified `repository` claim.

Then it parses `config` with `parseCentaurConfig` and, in order:

1. requires the bot's `platform`, `token` and webhook/signing secret in SSM, with a platform that
   matches the config;
2. refuses if `bots/<bot>/repo` holds a different repo (`centaur bot unbind` first);
3. writes `bots/<bot>/repo`, then the registry entry `registry:<bot>` = `{ allow, destination }`;
4. for Telegram, calls `setWebhook` with `<FUNCTION_URL>/telegram/<bot>` and the stored webhook
   secret. Slack needs no call.

Re-registering from the owning repo is idempotent. Binding is check-then-write, so two repos
registering a fresh bot at the same instant could race; the maintainer's secret creation is the
gate, which makes this a low risk.

## Lambda configuration

Environment variables (a later infra change wires them; `STATE_TABLE_NAME` already exists):

| Variable | Used by | Meaning |
|---|---|---|
| `STATE_TABLE_NAME` | both | DynamoDB state table. |
| `GITHUB_OWNER` | poster | Allowed repository owner; same value as the template's `GitHubOwner`. |
| `OIDC_AUDIENCE` | poster | Audience the workflow requests for its OIDC token (`audience=` on the token request); a fixed string agreed with the workflows. |
| `FUNCTION_URL` | poster | Public base URL of the function URL, used to build webhook URLs. |

IAM for the function role: everything the receiver has, plus `ssm:PutParameter` on
`/centaur/bots/*/repo` (`register` writes only that parameter). It still needs
`ssm:GetParametersByPath` on `/centaur/bots`, `ssm:GetParameter` on `/centaur/chats/*`, KMS decrypt,
and read/write on the state table.

For callers, the GitHub OIDC role needs `lambda:InvokeFunction` on the function (not the function
URL). The workflow assumes that role for AWS access and separately requests the audience-scoped
JWT to pass as `token`.

## Design notes

- **One function, two entry points.** A single cold-start path for SSM and state; the function URL
  can't be IAM-authenticated without also locking out Telegram and Slack, so the poster is
  reachable only through `lambda:InvokeFunction`.
- **The Lambda's SSM store gained `put`; the CLI keeps its own store.** The CLI needs
  SecureString writes, listing and deletion, while the Lambda only needs a plain-`String` write;
  merging the interfaces would force each side to implement operations it never uses.
