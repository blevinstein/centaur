# Hosted option

Status: **proposal**, not built on `main`. It answers the backlog item in [TODO.md](../../TODO.md):
run centaur as a service on central AWS infrastructure. The goal is that a person clicks "sign up
with GitHub" and gets a working centaur bot, **without an AWS account** and without deploying
anything. The operator runs one shared multi-tenant service (one Lambda deployment, one state
table, one session bucket); tenants bring their own model key (BYOK), their own chat-platform bots
and their own GitHub Actions minutes.

Self-hosted single-tenant deployments keep working unchanged ([Migration](#migration-and-slices)).

Facts that are not verified against current vendor docs are marked *(unverified)*: prices, quotas,
GitHub App and OIDC behavior, Slack and Telegram behavior. Re-check each before building on it.
Prices are list prices from memory (us-east-1).

## What is already tenant-owned

The agent does not run on centaur's infrastructure, so most of BYOK exists today:

- **The agent runs in the tenant's GitHub Actions**, in the tenant's repo, with the tenant's
  `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`) repo secret ([workflows.md](../workflows.md)). The
  service never sees the model key and never pays for model usage.
- **Turn compute is the tenant's Actions minutes.**
- **Durable memory is the tenant's repo.**

What the service holds is the thin part: the receiver and poster Lambda, the state table (dedupe,
locks, transcripts, thread metadata, registry), the session bucket (resume files, attachments),
and the secrets the Lambda needs to talk to the chat platforms and to GitHub.

| Asset | Today (self-hosted) | Hosted owner |
| --- | --- | --- |
| Model API key | Repo secret | Tenant. Never reaches the service |
| Agent compute | Tenant's Actions runners | Tenant |
| Telegram or Slack bot token, webhook or signing secret | SSM `bots/<bot>/platforms/<platform>/` | Tenant supplies, service stores encrypted |
| GitHub credential for `repository_dispatch` | SSM `github/token` (one PAT) | Service mints short-lived tokens from a GitHub App installation |
| Transcripts, thread metadata, registry, access lists | State table (`pk` starts with `bot:<bot>:`) and SSM | Service stores, tenant's data |
| Session files, attachments | S3 `sessions/<bot>/...`, `attachments/<bot>/<thread>/...` | Service stores, tenant's data |

## Recommended design in one page

- **Tenant** = one GitHub owner (user or org), identified by its immutable numeric ID, never by name.
- **Sign-up** = install a **GitHub App** on chosen repos. The install flow is the sign-in, the
  consent and the dispatch credential in one click.
- **The service opens a setup pull request** in the chosen repo with the config, persona and
  workflow files. The tenant merges it and adds one repo secret (the model key) by following a link.
- **Tenant runners authenticate with the GitHub OIDC JWT only.** No AWS role, no AWS account. The
  poster becomes an HTTPS endpoint on the same function URL, and session files move through
  presigned URLs.
- **Every key is tenant-scoped** (state table, S3, secrets), and every request resolves its tenant
  from a verified claim or from an opaque webhook ID, never from request content.
- **Operator controls**: per-tenant quotas, a suspend flag, separate functions with their own
  concurrency caps, and CloudFront with WAF in front.

### Rejected alternative: a cell per tenant

A stack of `infra/centaur.yml` per tenant in a hosting account gives hard isolation (separate table,
role and SSM subtree, `delete-stack` for offboarding), and it needs almost no code. It is rejected
because provisioning a CloudFormation stack, table, role and OIDC trust on every click is
heavyweight, it is bounded by per-account quotas (stacks, tables, Lambda concurrency; a few hundred
cells at best *(unverified)*), every code release must be rolled across every cell, and it still
leaves a trusted AWS role in each cell. The cost of the shared design is that isolation moves into
application code, which [Security](#security-and-isolation) addresses.

## Sign-up flow

### GitHub OAuth app or GitHub App

| | OAuth app | GitHub App |
| --- | --- | --- |
| Repo access | Scopes are user-wide (`repo`, `workflow` cover every repo the user can reach) *(unverified)* | Tenant picks repos at install; permissions are fine-grained |
| Dispatch credential | Must store a long-lived user token | Short-lived installation token minted on demand, restricted to one repo and one permission set *(unverified)* |
| Org installs | Org policy can block or require approval | Org owner installs; approval flow built in *(unverified)* |
| Lifecycle events | None | `installation` and `installation_repositories` webhooks tell the service about uninstall or repo changes |
| Sign-in | Native | The App can also request user authorization ("Sign in with GitHub") to identify the installer *(unverified)* |

**Recommendation: a GitHub App.** It is the only option that avoids storing a user's long-lived
token, scopes access to repos the tenant picks, and tells the service when the tenant leaves. Plain
OAuth is used inside the App flow only to identify the installing user.

App permissions (*all unverified, confirm in the App permissions reference*):

- **Contents: write.** Required for `repository_dispatch` (the template's PAT already needs this)
  and to write the setup branch.
- **Pull requests: write**, to open the setup pull request.
- **Workflows: write**, because creating or changing files under `.github/workflows/` needs it.
- **Metadata: read** (implicit).
- Not requested: Secrets, Administration, Actions. The model key stays out of the service's reach.

The cost is that **Contents: write across every installed repo is a high-value central credential**
(see [Security](#security-and-isolation)). A narrower alternative is to dispatch with
`workflow_dispatch`, which needs the Actions permission instead of Contents *(unverified)*. That
changes the dispatch contract (inputs instead of `client_payload`, a ref to run, input size limits)
and is an [open question](#open-questions-for-the-maintainer).

### What the tenant clicks

1. **"Sign up with GitHub"** on the service's site sends the browser to the App's install page.
   GitHub asks which account (user or org) and which repos. An org requires an owner or the App
   manager *(unverified)*.
2. GitHub redirects back with an installation ID and an authorization code *(unverified)*. The
   service exchanges the code for a user token, calls `GET /user/installations` (or equivalent) to
   confirm the user can see that installation, reads the owner's numeric ID, and creates or reopens
   the **tenant record**. The user token is used once and discarded; a signed, short-lived session
   cookie identifies the browser afterwards.
3. **Connect a chat platform** (web form, below).
4. **Setup pull request.** For each chosen repo the service creates a branch and opens a PR with
   `.centaur/config.yml`, `.centaur/persona.md`, a sample prompt and the caller workflows from
   [workflows.md](../workflows.md#consumer-workflows). The workflows `uses:` the operator's public
   `centaur` actions at a pinned tag. The tenant reviews and merges; nothing lands without that
   merge.
5. **Add the model key**: a button deep-links to the repo's Actions secrets page (`New repository
   secret`, name prefilled). The key goes to GitHub, never to the service. The service cannot see
   it, which keeps the main custody burden off the operator. (Writing the secret through the API
   would need the Secrets permission and make the service handle the key transiently; not worth it.)
6. The merge triggers the existing `register` job. The first DM claims admin, approvals happen in
   chat, exactly as [onboarding.md](../onboarding.md) describes.

The repo variables set by `centaur repo vars` today (`CENTAUR_ROLE_ARN`, `CENTAUR_AWS_REGION`,
`CENTAUR_FUNCTION_NAME`, `CENTAUR_OIDC_AUDIENCE`, `CENTAUR_SESSION_BUCKET`) disappear: with an HTTPS
transport the only constants are the service URL and audience, baked into the pinned action
version.

### Bot tokens and secrets: the web form

Bot creation stays with the platforms; nothing can create a Telegram bot or Slack app on the tenant's
behalf.

- **Telegram.** The form shows BotFather steps, takes the bot token, calls `getMe` to validate it,
  generates the webhook secret, and stores both. `register` later calls `setWebhook` with
  `https://<hooks-domain>/telegram/<botId>` as it does today ([poster.md](../poster.md#register)).
- **Slack.** The form renders [slack-app-manifest.yml](../slack-app-manifest.yml) with the tenant's
  event URL filled in, for "Create from manifest" (a prefilled-manifest link may exist
  *(unverified)*), then takes the signing secret and bot token. Tenant-owned Slack apps keep the
  operator out of Slack's app directory review.
- **Transport.** TLS to the service only, CSRF-protected, session-authenticated and
  tenant-authorized. Secrets are write-only in the UI: after saving, the page shows presence and
  last four characters at most, replacement and deletion only.
- **Rotation.** Pasting a new value replaces it; the old ciphertext is deleted.

### What replaces the CLI and SSM steps

| [onboarding.md](../onboarding.md) step | Hosted replacement |
| --- | --- |
| `yarn deploy-prod`, parameters file, OIDC provider | None. The operator deploys once |
| `centaur github-token set` | App install; no stored token |
| `centaur bot add` | Web form (above) |
| `centaur repo vars`, copy workflows | Setup pull request |
| `ANTHROPIC_API_KEY` repo secret | Same, via deep link |
| `centaur admin claim` | Same one-time link or code, issued by the web UI and the poster |
| `centaur access approve|list|revoke|block` | In-chat approvals (unchanged); a web list view later |
| `centaur destination set`, `centaur bot unbind`, `centaur bot backup` | Web pages calling the same service operations |

The CLI can be kept as a thin client of the same HTTPS API for power users, replacing its `ParameterStore`
([src/cli/parameter-store.ts](../../src/cli/parameter-store.ts)) with an authenticated remote
backend; that is optional.

## How the tenant's runner authenticates

Today the workflow assumes the template's role through `aws-actions/configure-aws-credentials`
([setup-runtime](../../.github/actions/setup-runtime/action.yml)), then calls `aws lambda invoke`
(`src/workflows/aws.ts`) and reads and writes S3 with the role. A shared service cannot hand out an
AWS role: a role trusting `repo:*/*` would let any repository on GitHub invoke it.

Replacement, using pieces that already exist:

1. **The poster over HTTPS.** The handler already treats a request with an `operation` key as a poster
   request, and the function URL is already public (`AuthType: NONE`). Add a route `POST /poster`
   whose JSON body is the same request shape; map poster errors to HTTP status codes instead of
   Lambda `FunctionError`. Function URL payloads are limited to a few MB *(unverified)*, which
   matches the sizes `read` returns.
2. **Authentication is the GitHub OIDC JWT** on every operation, in the `Authorization` header (the
   body `token` field is accepted during the transition). `src/lambda/oidc.ts` already verifies
   signature, issuer, audience and expiry against GitHub's JWKS. The verifier changes from "owner
   equals the configured `GITHUB_OWNER`" to "resolve the tenant from the `repository_owner_id`
   claim" *(the claim name is unverified; GitHub documents numeric owner and repository ID claims
   in its OIDC token reference)*, then compare the repo (by numeric `repository_id`, *unverified*)
   with the bot's binding. The audience becomes a service-specific value (the service's own URL).
3. **S3 by presigned URL.** The poster returns presigned GET URLs for resume files and attachments
   and presigned POST policies (size-limited with `content-length-range`; a presigned PUT does not
   cap size *(unverified)*) for session upload. URLs are scoped to
   `sessions/<tenantId>/<bot>/<thread>` after the same JWT and binding check, and expire in minutes.
   The runtime in `src/workflows` swaps its `aws s3` and `aws lambda` calls for an HTTP client behind
   one interface.
4. **Short-lived by construction.** GitHub OIDC tokens expire in minutes *(unverified)*; the service
   rejects tokens older than a small window and relies on the audience and `repository_id`
   binding. A `jti` replay cache is optional *(whether `jti` is present is unverified)*.

This transport also benefits self-hosted operators who do not want the OIDC role at all; see the
slices.

## Tenant data model

### Identifiers

| ID | Form | Notes |
| --- | --- | --- |
| `tenantId` | Opaque random, e.g. `t_` plus 128 bits | Maps 1:1 to GitHub `owner_id`; stored on the tenant record with the App installation ID. Never the owner name, which can be renamed or re-registered |
| `botId` | Opaque random, globally unique | Appears in the webhook path. Maps to (`tenantId`, bot name). The bot name from `.centaur.yml` stays a tenant-local label |
| Repo binding | Numeric `repository_id`, plus current `owner/name` for display | Replaces today's `bots/<bot>/repo` string, so a renamed or transferred repo name cannot be hijacked |

### State table

The shared table keeps the template's schema (`pk`, `sk`, `ttl`, on-demand). The state adapter
(`@blevinstein/chat-state-dynamodb`, built in `src/lambda/handler.ts` from a `keyPrefix`) puts the
prefix in the **partition key** (`bot:<bot>:...`, see `test/chat-dynamodb-state.test.ts`). DynamoDB
cannot query "all partition keys starting with X", so deleting or exporting one tenant from a shared
table would take a full-table scan.

Design:

- **Key prefix**: `keyPrefix` becomes `t:<tenantId>:bot:<bot>:`. The records written under the empty
  prefix today (`pull-request:<repository>#<n>`, `registry:<bot>` through `registryKey`, access
  request records) also take the tenant prefix; none may stay global.
- **Tenant attribute plus sparse GSI.** The adapter writes a `tenant` attribute on every item and the table
  gains a GSI (`tenant` partition key, `pk` sort key). Offboarding and export query the GSI by
  tenant and batch-delete, cost proportional to the tenant's data, not the table. This is a change
  to the adapter package (the maintainer owns it) plus a table parameter (a new GSI on the shared
  table; a one-time backfill for existing items).
- **Generation for instant logical delete.** Tenant records carry a `generation`; the prefix is
  `t:<tenantId>:g<generation>:bot:...`. Bumping it makes old data unreachable at once, and the
  GSI-driven sweeper (or TTL) removes it afterwards. This also gives "delete my data" an immediate
  effect while the physical delete runs.
- **Hot partitions.** Partition keys already spread by thread and chat, so one tenant does not
  concentrate on one partition. The 400 KB item limit bounds a history list (`HistoryMaxMessages`).
- **Per-tenant history window.** `HISTORY_MAX_MESSAGES`, `HISTORY_TTL_DAYS`
  (`src/lambda/history-window.ts`) are environment-wide today; they become tenant plan values read
  from the tenant record.

### Secrets and configuration

SSM does not fit: the receiver loads `/centaur/bots` once per cold start (`src/lambda/registry.ts`
`loadBots`, `src/lambda/cached-parameters.ts`), which would read every tenant's tokens into one
process; standard parameters are capped at 10,000 per account and region and each bot uses several
*(unverified)*; and `GetParametersByPath` is throttled *(unverified)*. The parameter interfaces
(`ReadableParameters` in `src/lambda/parameters.ts`) already separate callers from SSM, so a new
backend slots in behind them:

- **A tenant parameter store in DynamoDB** (a `config` item family under the tenant prefix, or a second
  small table). Non-secret items (repo binding, approved and blocked chats and users, admin, admin
  claim, approvers, MCP approvals, destinations) are plain records. They were SSM paths
  (`/centaur/bots/<bot>/...`, `/centaur/chats/<platform>/<name>`, `/centaur/admin/<platform>`);
  `admin/<platform>` and `chats/<platform>/<name>` are **stack-wide** today and must become per
  tenant, or one tenant's admin would be everyone's.
- **Secret items are envelope-encrypted.** Bot tokens and webhook or signing secrets are encrypted
  with a KMS data key (`GenerateDataKey`), with the encryption context
  `{tenantId, botId, platform, field}`, using an established library (the AWS Encryption SDK or the
  DynamoDB Encryption client, not hand-rolled), and decrypted per request with a short TTL cache
  (`src/lambda/ttl-cache.ts`).
- **One KMS key with encryption context, not a key per tenant.** A key per tenant costs about $1 per
  month each *(unverified)* and, because the Lambda role is shared, does not isolate anything
  (the role can decrypt all of them). The encryption context still binds ciphertext to its owner (a
  swapped item fails to decrypt) and makes CloudTrail show which tenant a decrypt was for. A per-tenant key becomes worthwhile only for a
  paying tier that wants its own key to revoke.
- **Secrets Manager** is another option; at about $0.40 per secret per month *(unverified)*, two
  secrets per bot makes it dearer than DynamoDB for the same job, and it adds API throttles.
- **Lookup by webhook ID.** The receiver resolves `/telegram/<botId>` to (tenant, bot) with one
  item read, then loads that bot only. The startup scan of all bots goes away. Negative lookups
  (unknown ID) are cached briefly so a scanner cannot drive reads.

### S3

One bucket, tenant in the key: `sessions/<tenantId>/<bot>/...` and
`attachments/<tenantId>/<bot>/<thread>/...` (today `sessions/<bot>/...` and `attachments/<bot>/...`).
Lifecycle rules stay prefix-based and are per tenant plan only by changing the tenant's object tags
or a second prefix class (standard `SessionExpirationDays` and `AttachmentExpirationDays` apply
bucket-wide; per-tenant retention would need object tags with tag-filtered rules *(unverified)* or
shorter bucket-wide defaults). Unlike DynamoDB, S3 prefix deletion is natural: list and delete
under `<tenantId>/`. The Lambda role keeps `s3:PutObject` on `attachments/*` and gains Get/Put on
`sessions/*` (the GitHub role's current permissions) for presigning. IAM cannot restrict the shared
role per tenant, so the key builder is the isolation point.

### Per-tenant limits

Stored on the tenant record, defaulted from a plan, enforced in code ([Limits](#abuse-and-cost-controls)):
bots, repos, connections, messages per day, dispatches per day, concurrent turns, stored bytes,
attachment size, history window, session retention.

## Webhook URL shape

A Lambda function URL is `https://<url-id>.lambda-url.<region>.on.aws/`, with no throttling, WAF or custom
domain *(CloudFront is the documented way to add them, unverified in detail)*. A custom domain is
needed so the registered webhook URL survives an infrastructure change and so rate limits apply.

- **Path per bot**: `https://hooks.<domain>/telegram/<botId>` and `.../slack/<botId>`. `botId` is
  opaque and globally unique, so no tenant segment is needed and the receiver's current routing
  (`/<platform>/<bot>`) only swaps `bot` for `botId`. The poster is `https://hooks.<domain>/poster`,
  and App webhooks `https://hooks.<domain>/github`.
- **Not a subdomain per tenant.** It needs a wildcard certificate and per-tenant DNS handling and gains nothing unless a tenant must be blocked
  at the edge; WAF can block by path pattern or `botId`.
- **Webhook secret**: already per connection, and a request is accepted only if it carries that
  connection's secret (Telegram `secret_token`, Slack signing secret). Telegram's secret is
  generated by the service (as in `centaur bot add`); Slack's is the tenant's app signing secret.
  Verification is constant-time and happens before any dispatch. An unauthenticated request costs
  one cached lookup and one HMAC.
- **Stable across suspension**: suspended tenants get a cheap reject (HTTP 200 to stop platform
  retries, nothing processed) so Telegram does not back off into long retry queues *(retry behavior
  unverified)*.

## Security and isolation

One shared function and one IAM role serve every tenant, so AWS cannot enforce the boundary. The
boundary is code; the rules below make it hard to violate by accident.

**Tenant context.** A single `TenantContext` is built once per request from a verified source (the
OIDC claim for poster calls, the `botId` lookup plus verified webhook secret for webhooks, the
session cookie for the UI) and is the only way to construct a state adapter, parameter store or S3
key. No operation reads a tenant, owner, repository or bucket key from the request body. This
extends today's rule that the repository comes from the verified claim (`src/lambda/register.ts`,
`requireBound` in `src/lambda/registry.ts`).

### Threats and mitigations

| Threat | Mitigation | Code that changes |
| --- | --- | --- |
| Tenant A posts or reads as tenant B's bot | Poster tenant comes from the OIDC `repository_owner_id`; bot looked up only inside that tenant; binding compared by `repository_id` | `src/lambda/poster.ts` (`requireBound` on every operation), `src/lambda/oidc.ts` |
| Poster caller check is optional until `RequirePosterToken=true` (the check is implemented; tokenless calls are still accepted by default, and `get-mcp-policy` is not tied to a repo; [poster.md](../poster.md#security-model)) | Mandatory JWT and bound-repo check on every operation. In a multi-tenant service this is the core isolation control, not a hardening | `src/lambda/poster.ts` schema (add `token`), `src/workflows` callers |
| Bot name squatting (`bots/<bot>/repo` is first-come, create-only) | Names are tenant-local; webhook IDs are random; binding is by repo ID | `src/lambda/registry.ts`, `src/lambda/register.ts` |
| Webhook forgery or replay of tenant A's request to tenant B's URL | Per-connection secret verified before processing; `botId` selects the connection so A's secret fails on B's path | receiver and `src/lambda/chat.ts` |
| Confused deputy on dispatch tokens: a tenant causes the service to use a token for a repo it does not control | Dispatch repo is read only from the bot's stored binding, which `register` sets from the OIDC `repository_id`. The installation token is minted for that installation, restricted to that repo, and only if the installation covers it | `src/lambda/github.ts`, a new token minter |
| Compromise of the central App key writes to every tenant's repos | Key in Secrets Manager (or an imported KMS key *(unverified)*) readable only by a tiny minter function; installation tokens requested with minimal `repositories` and `permissions`; alarm on use outside the minter; evaluate `workflow_dispatch` to drop Contents write | new minter function, infra template |
| Cross-tenant data via a missing prefix | One key-builder module; tests that run every operation as two tenants and assert disjoint item sets, on the pattern of `test/chat-dynamodb-state.test.ts` (`bot:a:` vs `bot:b:`) | `src/lambda/state.ts`, `src/lambda/handler.ts` |
| Tenant claims another tenant's GitHub owner | Tenant tied to `owner_id` through a verified App installation; org installs need an org owner *(unverified)*; owner rename or deletion does not transfer ownership because IDs are immutable | control plane |
| Stolen JWT replay | Short expiry, service-specific audience, `repository_id` binding; the JWT only reaches the repo's own workflows | `src/lambda/oidc.ts` |
| Prompt-injected agent in a tenant repo calls the poster | Same exposure as today, now limited to that repo's bound bots by the mandatory check; the agent action strips the OIDC variables from the agent environment, but the chat tools server keeps them (`src/workflows/turn-state.ts`), so the agent can reach only the chat tool operations | none beyond the mandatory check |
| Public or fork repo workflow triggers a flood | Dispatch only runs workflows on the default branch; tenant quotas cap dispatches; setup PR workflows use `repository_dispatch` and `schedule`, not `pull_request_target` | workflows |
| Noisy neighbor starves the function | Separate functions per surface (webhook receiver, poster API, control plane) with their own reserved concurrency, per-tenant token buckets in the table, WAF per-IP limits | infra template |
| Noisy neighbor on DynamoDB, KMS, SSM | On-demand table with per-tenant write quotas; KMS decrypt cache; no per-request SSM calls | state and parameter backends |
| Operator or staff reads tenant chats | No standing human access; break-glass is audited and shown to the tenant; logs never carry content (existing rule) | runbook |
| Tenant deletes the App, service keeps acting | `installation` deleted webhook sets tenant `suspended`; token mint fails closed | control plane |
| Log or error leakage across tenants | Logs carry tenant ID, bot ID, operation; never content or secrets (extends the existing rule) | all handlers |

What stays unchanged: access control inside a bot (admin plus approved chats and users, decided by
the tenant's admin on the platform) and the MCP approval flow. The operator never sits in a
tenant's chats.

## Abuse and cost controls

### Limits

- **Quotas in code.** Daily message, dispatch and attachment counters per tenant as atomic
  `UpdateItem` increments with a TTL, checked before the expensive work. Plan limits come from the
  tenant record. An over-quota inbound message gets one polite notice per interval, like the
  existing `DispatchFailureNoticeMinutes` rule. Existing limits remain (10 MCP approval requests
  per bot per hour).
- **Resource caps.** Max bots, repos, connections, history window, session size, 20 MB attachment
  cap (existing), presigned POST size policies, bounded `read` and `list-threads` limits (existing).
- **Reserved concurrency** cannot be per tenant on a shared function. Instead: separate functions,
  so a poster flood does not block webhooks; a reserved cap on each; an app-level concurrent-turn
  limit per tenant (a counter item per tenant with a lease TTL). Remember that reserved concurrency
  is carved from the account pool, and a new account may start low *(unverified)*.
- **Edge.** CloudFront in front of the function URLs (origin access control for function URLs
  *(unverified)*) with WAF rate rules per IP and per path; this is also the custom-domain
  requirement. Origin access means the raw `lambda-url` hosts stop being callable.
- **Kill switches**: tenant `status` (`active`, `suspended`, `deleting`) on the tenant record,
  cached for seconds and checked on every request; global switch by setting a function's reserved
  concurrency to zero or a WAF block rule; per-bot switch by clearing the webhook secret.
- **Sign-up abuse.** GitHub identity is the gate; add a minimum account age or invite code for the
  beta, and cap new tenants per day. Tenant GitHub spend limits are not the operator's problem, but
  a tenant dispatching into a repo with no Actions minutes should be detected from failed
  dispatches (the existing failure notice) and rate-limited.

### Who pays what

| Cost | Payer |
| --- | --- |
| Model usage (tenant key, `max_budget_usd` per turn in the config) | Tenant |
| GitHub Actions minutes for turns | Tenant (free allowance on public repos; plan minutes on private repos *(unverified)*) |
| Lambda, DynamoDB, S3, CloudFront, WAF, KMS, logs, domain | Operator |
| Chat platform costs (Telegram free; Slack plan) | Tenant |

### Rough cost model

All *(unverified)*, us-east-1 list prices from memory, 512 MB Node function, on-demand DynamoDB.

| Item | Price |
| --- | --- |
| Lambda | $0.20 per million requests, $0.0000166667 per GB-second |
| DynamoDB on-demand | $0.625 per million write units, $0.125 per million read units, $0.25 per GB-month |
| S3 | $0.005 per 1,000 PUT, $0.0004 per 1,000 GET, about $0.09 per GB out |
| CloudWatch Logs | about $0.50 per GB ingested |
| WAF | about $5 per web ACL per month, about $1 per rule, about $0.60 per million requests |
| KMS | $1 per key per month, $0.03 per 10,000 requests |
| Secrets Manager (if used) | about $0.40 per secret per month |
| Route 53 hosted zone | about $0.50 per month |

Per turn (one message in, one reply out): receiver about $0.00001, five poster calls about
$0.00005, DynamoDB about $0.0001 to $0.0003 (the adapter rewrites a whole history list per append;
see [chat-context.md](../chat-context.md#what-the-platforms-can-provide)), a few KMS decrypts
mostly cached, and S3 and logs under $0.001 combined. **About $0.0003 to $0.001 per turn, so $0.30
to $1 per thousand turns.** An HTTPS poster adds the CloudFront request fee per call, small next to
the Lambda cost.

Fixed: WAF, domain, hosted zone, a handful of keys and secrets, about $10 to $25 per month before
any tenant. Illustration: 1,000 active tenants at 300 turns per month is 300k turns, about $100 to
$300 per month. Per-tenant storage (a few MB of history and sessions) is cents. The infrastructure is
not the cost driver; support time, abuse handling and the legal posture are.

### Billing and free tier (open)

Beta: invite-only and free with the quotas above. After that, a flat plan with a message cap, or
usage overage; the unit of account is the turn. A payment path (a GitHub Marketplace listing, or a
separate payment processor) is a product decision and out of scope here.

## Offboarding and data deletion

- **Triggers**: the tenant presses delete, or the App is uninstalled (`installation` deleted event).
- **Immediate (minutes)**: set tenant `suspended`; stop minting tokens; for each Telegram bot call
  `deleteWebhook`; bump the tenant `generation` so existing data is unreachable.
- **Grace period**: a short configurable window (for example 14 days) in which re-installing restores the tenant, then the physical
  delete runs. A "delete now" button skips it.
- **Physical delete**: query the tenant GSI and batch-delete state items; delete the tenant's S3
  prefixes; delete the secret and config items; delete the tenant record last. Items with TTL also
  age out. CloudWatch logs hold no content and expire by retention.
- **Export first**: `centaur bot backup` (`src/cli/backup.ts`) already exports a bot's records; a
  hosted export button calls the same logic.
- **Slack apps and Telegram bots belong to the tenant**; the service tells the tenant to revoke the
  token at the platform, since the service cannot.
- **Backups**: do not enable point-in-time recovery or other backups that outlive deletion, or state
  their retention in the privacy policy.

## Privacy and legal

Not legal advice; a lawyer decides these before external tenants.

- **Roles.** The tenant is the controller of its chat members' data and the operator is a processor
  (transcripts, usernames, attachments, thread metadata) *(jurisdiction-specific)*. Needs a privacy
  policy, a data processing agreement and a subprocessor list (AWS, GitHub).
- **Retention.** Defaults are short (history 7 days, sessions and attachments 30 days today) and
  logs never hold content. Raising them is a plan option and a disclosed choice.
- **Platform terms.** Telegram bot tokens and Slack tokens held on a customer's behalf; review the
  Slack API terms and Telegram bot terms on third-party hosting and on storing end-user messages
  *(unverified)*. Keeping apps tenant-owned avoids directory review and shared-app rate limits, but
  not the hosting obligations.
- **GitHub terms.** GitHub App and API terms on automated PRs, rate limits (installation tokens are
  limited per installation *(unverified)*), and Actions usage (a service that triggers many runs is
  using the tenant's minutes, which is allowed but should be disclosed).
- **Model provider.** The tenant's key means the tenant's agreement with its provider; the
  operator's terms should require acceptable use and permit suspension.
- **Secrets custody.** The service stores bot tokens that grant full control of a tenant's bot.
  Encrypt (above), alarm on decrypts outside the function role, keep the hosting account separate
  from other workloads, and publish an incident process.
- **Content moderation and abuse reports.** Define who can ask the operator to suspend a tenant and
  what the operator can see without breaking the no-standing-access rule.

## Migration and slices

Self-hosted keeps working: the same code runs with an implicit single tenant derived from
`GITHUB_OWNER`, the SSM parameter backend, the existing key layout, and the AWS role path. The hosted
mode is a different composition of the same modules (tenant resolver, parameter backend, S3 key
builder, token minter), selected by deployment configuration. Existing self-hosted stacks need no
data migration; hosted tenants start fresh on the new layout.

In dependency order; each slice is useful on its own.

1. **Poster caller check, with no hosted dependency. Implemented on `main`; two follow-ups remain below.** Add `token` and the bound-repo check to
   `post`, `unreact`, `start-thread` and `get-mcp-policy`; pass the token from the workflow actions;
   add an opt-in `REQUIRE_POSTER_TOKEN` window so mixed action and Lambda versions work; update the
   security model in [poster.md](../poster.md#security-model); accept the owner ID (numeric) in the
   verifier alongside the name. Removes "any repo under the owner can act as any bot" for every
   self-hosted user, and is the base of the multi-tenant isolation.

   What landed: the check on all four operations, the `RequirePosterToken` window (default `false`),
   the numeric owner ID, and a warning log for tokenless calls. What remains for the hosted case:
   `get-mcp-policy` is verified by token only and not tied to a repo, because `register` reads the
   global policy before it binds a repo's first bot, so any valid in-owner token can read it
   (bind first then check, with rollback, or have `register` return the policy); and
   `RequirePosterToken` must be set to `true` once the tokenless warnings stop, since a hosted
   service cannot accept tokenless calls.
2. **HTTPS poster transport and presigned session access.** `POST /poster` on the function URL with
   the JWT in `Authorization`, the `src/workflows` transport interface with an AWS-invoke
   implementation (default) and an HTTPS one, presigned GET and POST for session files and
   attachments. Self-hosted operators may adopt it to drop the workflow AWS role; the template's role becomes optional.
3. **Tenant-scoped storage.** Thread a tenant through `keyPrefix`, the S3 key builder and the parameter
   interfaces, with the implicit-tenant default; add the `tenant` attribute and GSI to the state
   adapter and template; two-tenant isolation tests.
4. **DynamoDB parameter store with envelope-encrypted secrets**, lookup by `botId`, and per-request
   (not cold-start) loading in the receiver; per-tenant admin, destinations and access lists.
5. **Control plane**: the GitHub App, the sign-in and install callback, tenant records, the secret
   intake form, the setup pull request, `installation` webhooks, the token minter, and suspend and
   delete operations. Invite-only beta with a handful of tenants.
6. **Limits and edge**: quotas, token buckets, separate functions with concurrency caps,
   CloudFront and WAF, the custom domain, alarms, runbooks.
7. **Billing, legal documents, public sign-up.**

Slices 1 and 2 are small, independent of whether the service ships, and improve the self-hosted
product. Slices 3 and 4 are the largest code change and touch the adapter package.

## Open questions for the maintainer

1. Product or friends-and-family beta? It decides whether slices 6 and 7 exist and who carries the
   privacy and legal burden.
2. Is a central GitHub App with Contents write across tenant repos acceptable, or should dispatch
   move to `workflow_dispatch` (Actions permission) to narrow it? That changes the dispatch
   contract.
3. Should the state adapter package gain the `tenant` attribute and GSI, or should the key layout
   change (a different partition key scheme) instead? The adapter is the maintainer's package, so
   either is possible.
4. Should the HTTPS poster transport be offered to self-hosted operators (slice 2), making the
   workflow AWS role optional, or kept hosted-only?
5. Region: one region, or per-tenant data residency?
6. Retention defaults for hosted tenants, and may a tenant raise them?
7. Operator MCP policy ([infra/mcp-policy.cedar](../../infra/mcp-policy.cedar)): one service-wide
   policy bundled with the code, or per-tenant policies? Today it ships in the Lambda zip.
8. Pricing posture after the beta: free with quotas, flat fee, or metered per turn?
9. Is writing the model key as a GitHub secret through the App (Secrets permission) ever acceptable,
   or does the key always go to GitHub through the tenant's own click?
10. Does the operator publish the `centaur` actions publicly (needed so tenant repos can `uses:`
    them without an Actions access setting)?
