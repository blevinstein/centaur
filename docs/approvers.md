# Approvers

Design for a group of **approvers** besides the platform admin: people the admin authorizes, from
Slack or Telegram, to decide requests the bot sends for approval.

Status: implemented, slices 1 to 5 and the docs (7); see the [implementation map](#implementation-map).
Slice 6 (opening `chat` and `user` requests to approvers) is not built and stays optional: it needs
Decision 1 amended, and the admin deciding those requests alone is the safer default. The
[Decisions](#decisions) are the accepted design. Terms (admin channel, access request, claim) are
defined in [plan.md](plan.md#access-requests); the request kind that motivates this is in
[mcp-approval.md](mcp-approval.md).

## Summary of the design

- Today one user per platform (`/centaur/admin/<platform>`, global across bots) receives every
  request as a DM and is the only user `access-decisions.ts` accepts, for a reaction or for
  `/approve <id>` and `/deny <id>`.
- An approver is a user ID stored per bot connection, next to the approved users:
  `bots/<bot>/platforms/<platform>/approvers/<userId>`. The admin is always an approver; no approvers
  means today's behavior.
- **Chat is the way to add one.** An approved user DMs the bot `/approver request` (Telegram) or
  `approver request` (Slack). The admin receives the usual DM (a new `approver` request kind) and
  decides with 👍 or 👎. The requester's ID comes from their own message, so no ID resolution is
  needed on either platform. Only the admin can decide this kind.
- A direct form for the admin (`approver add` replying to the person on Telegram, naming a `<@U…>`
  mention in a DM on Slack), `approver remove`, `approver list` and `approver leave` follow in a
  second slice. The CLI (`centaur approvers list|remove|add`) is the operator's fallback.
- The first version covers **MCP approvals only**. The bot sends each MCP request as a DM to the admin
  and to every approver; the first valid decision claims it (the existing single-use claim).
- Every decision re-reads the set, so a removal takes effect on the next reaction or command.

## What the code does today

| Fact | Where |
|---|---|
| The admin check is `userId === lookupAdminId(params, platform)`, run for a reaction (DMs only, on a message linked to a request) and for `/approve` and `/deny` (DMs only). A non-admin reaction is logged and ignored; a non-admin command returns `undefined` and falls through to `processMessage` | `access-decisions.ts` (`isAdmin`, `fromReaction`, `fromCommand`), `admin-handlers.ts` |
| One decision per request: `claimDecision` is `setIfNotExists` on `access-request-claim:<id>`; the applier failing releases the claim | `access-request-store.ts`, `access-decisions.ts` (`resolve`) |
| A request is sent by `channel.notify(messenger, adminId, text)` (open a DM, post, return the message ID), linked with `access-request-message:<message id>` | `access-requests.ts` (`createRequestRaiser`), `admin-channel.ts` |
| Limits: one pending slot per subject, 10 new requests per bot per hour (`REQUESTS_PER_HOUR`), 7-day TTL | `access-request-store.ts` |
| No admin for the platform: no request is raised (`lookupAdminId` is empty) | `access-requests.ts` |
| The admin is global per platform; approved and blocked users are per bot connection (`approved-users/<id>`, JSON entry `{name?, at}`); the receiver's `getByPath` reads are uncached while `get` is cached 30 s | `access-entries.ts`, `connection-paths.ts`, `access.ts`, AGENTS.md |
| Telegram registers slash commands; Slack has none (`commands: false`, and the app manifest has no `slash_commands` feature). A Slack DM word like `claim <code>` is parsed in the message handler before the access checks | `admin-channel.ts`, `admin-handlers.ts`, `message-handler.ts`, `docs/slack-app-manifest.yml` |
| Slash handlers bypass the message handler and its allowlist, so each authorizes itself and falls back to `processMessage` | AGENTS.md, `admin-handlers.ts` |
| The MCP approval record stores the approver (`{at, approver}`); the denial record is `true`; an access approval entry has `{name, alias, at}` and the decision log line omits the approver, although `Decision` carries `approverId` | `access-decisions.ts` (`applyMcp`, `applyAccess`, `resolve`) |
| An MCP request stores `threadId` and `messageId` of the triggering message, not its author. A `user` request's `subjectId` is the requester | `access-request-store.ts`, `access-requests.ts` |
| The Lambda role reads `bots/*` recursively (`GetParametersByPath`); it writes only `repo`, `approved-*`, `blocked`, `mcp-approvals` under `bots/` and deletes only `admin-claim/*` | `infra/centaur.yml` |

What the Chat SDK adapters expose (read in `node_modules/chat` and `node_modules/@chat-adapter`):

| Question | Telegram | Slack |
|---|---|---|
| Who sent a command or message | `event.user.userId` from `message.from.id`, never forgeable by the sender | `event.user.userId` from the signed payload (`user_id`) or event `user` |
| Can the handler see the person a message replies to | Yes. A slash command event carries `raw` (the Telegram message), and `raw.reply_to_message.from.id` is the replied-to author; an ordinary `Message` has `replyTo` with its `author`. The command entity must start the message (`offset === 0`), and a command with `@otherbot` is ignored | Not applicable: the Slack route is a DM word |
| Can a message name another user | A `text_mention` entity carries `user.id`, but Telegram only creates it for users without a username; a plain `@username` is a `mention` entity with no ID, and a bot cannot resolve a username to an ID | The raw event text holds `<@U123>` (the adapter rewrites and resolves these forms). A slash command is not usable: none is registered, and its `@name` text is not an ID unless the app enables escaping |
| Message ID given to a reaction | `<chatId>:<messageId>`, unique across chats | The bare message `ts` (`event.item.ts`); the channel is only in `event.thread` |
| Group reactions | The webhook already subscribes to `message_reaction` (`WEBHOOK_UPDATES`) and the adapter forwards it; whether Telegram delivers it for a group depends on the bot's role there (Telegram's rule, not checked in code), so a design that depends on it is not proposed | `reaction_added` is subscribed; channel reactions need the bot in the channel |

## 1. Scope: which requests approvers decide

| Option | Assessment |
|---|---|
| A. MCP approvals only | The question is bounded: a server definition from the default-branch config that already passed the Cedar ceiling, so an approver can only enable something the operator policy allows. |
| B. MCP approvals and access requests | An access approval admits a chat or a user: it decides who can run turns with the repository's secrets and MCP servers. That is the admin's authority today, and a bad approval is wider than a bad MCP approval. |
| C. Chosen per kind in config | A knob per kind, stored in SSM next to the set. More surface than the problem needs. |

Recommendation: **A**, with the gate being a constant list of kinds an approver may decide
(`mcp`), so B later is a one-line change plus a decision. Chat and user requests keep going to the
admin alone. The new `approver` kind is never on that list.

## 2. What an approver can do

| Action | Admin | Approver |
|---|---|---|
| Decide an `mcp` request (reaction, `/approve`, `/deny`) | yes | yes |
| Decide a `chat`, `user` or `approver` request | yes | no |
| Add or remove approvers, list them | yes (chat, CLI) | no |
| Leave (remove themselves) | not applicable | yes |
| Claim admin (`/start <code>`, `claim <code>`) | the code holder | no: the claim code is independent of the set |
| Change bot config, policy or secrets | no (CLI with AWS credentials) | no |

An approver who is not also an approved user gets no chat access: an approver is not added to
`approved-users`, and the receiver's access check (`access.ts`) is unchanged. The way in is the other
way round: only an approved user may ask to become an approver (section 3).

## 3. Who authorizes approvers, and how

The maintainer's requirement is chat first. Three ways to add an approver from Slack or Telegram:

| Option | Mechanism | Assessment |
|---|---|---|
| A. The admin names the user | Telegram: `/approver add` as a reply to the person's message (`raw.reply_to_message.from.id`), or `/approver add <numeric id>`. Slack: a DM to the bot, `approver add <@U123>`, parsed from the raw text like `claim <code>`. Admin-only | The admin acts directly and nobody is asked. ID resolution differs per platform and has holes: a Telegram username mention carries no ID, a reply needs the person to have said something in a chat the bot sees, and a forwarded message may hide its sender. Slack's route needs no manifest change only because it is a DM word, not a slash command. |
| B. The person asks | The person DMs the bot `/approver request` (Telegram) or `approver request` (Slack). The receiver raises a new `approver` request to the admin: the usual DM, 👍 or 👎, `/approve <id>` on Telegram, 7-day TTL, hourly limit, claim and audit. Only the admin decides this kind | The ID is the sender's own, identical on both platforms, no resolution and no handler for entities. Reuses the whole decision path; one new kind. The cost is that the person must start it, so the admin tells them to. |
| C. Both | B, plus A as a shortcut | The admin needs A only to skip the person's step, and A carries the ID problems above. |

Recommendation: **B first; A as a second slice (C), limited to the two routes that are cheap and
exact**: Telegram reply, and the Slack DM mention. Evidence: B needs no part of the SDK beyond
`message.author.userId`, which both adapters set from the platform and the sender cannot influence;
A depends on reply and entity fields (`raw.reply_to_message` and `<@U…>` in raw text) that the
adapters expose only as `unknown` raw payloads, so it needs a narrow parsed type and fakes. Slack
slash commands are not proposed: they need a manifest change, a reinstall (**[HUMAN ACTION]**) and give
`@name` rather than an ID.

**One handler for every chat command.** `/approver <sub>` on Telegram and `approver <sub>` as a DM
word on Slack share one parser and one handler, `approverCommand({ userId, isDM, text, replyToUserId?,
mentionedIds? })`, so the platform code only extracts those fields. A slash handler authorizes itself
(AGENTS.md) and returns `undefined` for anything it does not own, which falls back to
`processMessage`.

| Subcommand | Who | Where | Effect |
|---|---|---|---|
| `request` | an approved, unblocked user who is not the admin or an approver | DM only | Raises an `approver` request for their own ID |
| `leave` | an approver | DM only | Deletes their own entry |
| `list` | admin | DM only | Posts the IDs and names (slice 4) |
| `remove <id>` or reply or mention | admin | DM; Telegram reply in any chat | Deletes that entry (slice 4) |
| `add <id>` or reply or mention | admin | DM; Telegram reply in any chat | Writes the entry (slice 4) |

Command rules: `add` and `remove` outside a DM are accepted on Telegram only as a reply, and answer in
that chat with a fixed line ("Added", "Removed"), no message content. A refused command (not the admin,
not approved) falls through and gets the bot's normal treatment: a stranger's `/approver request`
becomes the usual user access request, so it cannot spam the admin with a second kind.

**The `approver` request kind.** `subjectId` is the requester's user ID, `subjectName` their display
name, `threadId` their DM. It is one more entry in the appliers (`access-decisions.ts`), the
`APPROVED_TEXT` map ("You're now an approver for this bot.") and `DENIED_TEXT`. Approval writes the
set entry (`encodeEntry({name})`) if the set is below the cap; at the cap the claim is released and the
admin sees the error. Denial blocks nothing and writes a 7-day denial record, so the same person
cannot ask again until it expires; the denial key becomes `denied:<kind>:<subjectId>` for every kind
that records one.

**Abuse and noise.**

| Question | Rule |
|---|---|
| Who may send a request | Only an approved, unblocked user (the check `access.ts` already makes), in a DM. A stranger gets the ordinary access request, so a request kind never reaches the admin from someone the admin has not admitted |
| Spam from an approved user | One pending slot per user (`claimSubject`), the 7-day denial record, and the hourly limit of 10 requests per bot, which all kinds share. A burst of requests can use up the limit and delay an access request until the hour ends; a per-kind limit is not proposed |
| Who decides | Only the admin: `approver` is outside the approver kind list, so an approver cannot enlarge the set. No approver is created without the admin's reaction or the admin's own command |
| What the DM contains | `Kind: approver`, the bot, the requester's display name and ID, never message content |

Layout (per bot connection, a sibling of `approved-users`):

| Key | Value |
|---|---|
| `bots/<bot>/platforms/<platform>/approvers/<userId>` | the `encodeEntry` JSON (`{name?, at}`), read with `decodeEntry` |
| `/centaur/admin/<platform>` | unchanged; the admin is not stored in the set |

Per bot connection rather than global like the admin, because an approval is a per-bot decision and a
household may trust one person with one bot only; `centaur bot remove` already deletes everything under
the connection path, so no leftover. `parseBotParameter` ignores keys deeper than a direct connection
key, so the registry does not see them. Helpers go in `connection-paths.ts` (`approversPrefix`,
`approverParameter`), read with `getByPath` (uncached, so a removal is immediate). **The receiver now
writes and deletes this path**, so the Lambda role gains `ssm:PutParameter` and `ssm:DeleteParameter` on
`parameter/centaur/bots/*/platforms/*/approvers/*`, which is a **[HUMAN APPROVAL]** deploy of the
Lambda and the stack (`yarn lint:cfn` after the template change).

**The CLI is secondary.** `centaur approvers list <bot>` and `remove <bot> <user>` (`--platform` as in
`centaur access`) let an operator inspect and cut access without chat. `add` is included because it is
about ten lines on the same helpers (`access approve` is the model), with the same refusals: no admin
on the platform, the admin's own ID, over the cap. None of them needs a deploy.

## 4. How approvers are asked

| Option | Assessment |
|---|---|
| A. DM the admin only | Today. Approvers could decide only by knowing the request ID, which only the DM carries, so it does not deliver the feature. |
| B. DM the admin and each approver | One request, N+1 DMs. Each DM is linked to the same request. The first decision wins through `claimDecision`; a later reaction or command gets "already handled". Works unchanged on both platforms and keeps the DM-only rule. |
| C. A shared approvals group chat | One message, any member who is an approver may react. Needs reactions outside DMs (`fromReaction` ignores them) and group delivery of Telegram reaction updates, which depends on the bot's role in the group. The request summary becomes visible to non-approvers. |

Recommendation: **B in version 1**; C is a possible later channel, not built.

Rules for B:

- Fan-out: the raiser calls `channel.notify` for the admin and for each approver (up to the cap) and
  links every returned message. The request is kept if at least one DM was delivered; a failed DM is
  logged by ID and skipped. Only when none was delivered does the raiser remove the request and report
  "unreachable" (as it does for the admin today).
- Only `mcp` requests fan out; `chat`, `user` and `approver` requests DM the admin alone.
- Noise: the hourly limit counts requests, not DMs, so the bound is 10 requests times (approvers + 1)
  DMs per bot per hour. The other DMs are left as they are; editing or deleting them is not offered by
  `DirectMessenger` and is not proposed.
- An approver added after a request was raised is not sent it, and cannot guess its ID.
- **Message link key.** Today the link is `access-request-message:<message id>`. Slack reports a
  reaction with the bare `ts`, so two DMs (the admin's and an approver's) whose messages share a `ts`
  would map one reaction to the wrong request. Every link and lookup uses
  `access-request-message:<channelId>:<messageId>`, where `channelId` is `Thread.channelId` of the DM on
  the way in (so `notify` returns `{ channelId, messageId }`, from the DM thread it posted in) and
  `event.thread.channelId` on the way out. Telegram message IDs already include the chat, so the same
  key shape costs nothing there. This is part of the fan-out slice, not optional.

## 5. Security

| Concern | Rule |
|---|---|
| Who may decide | A decision is accepted only from a user ID that is the admin, or is in the set of **this bot's connection on this platform** (the receiver instance and the request's `threadId` prefix are already per platform). An approver on Telegram grants nothing on Slack: user IDs are never compared across platforms. |
| Kind gate | The check is `mayDecide(kind, userId)`: the admin for every kind, an approver for the kinds in the approver list (`mcp`). A refused approver on a command gets "Only the admin can decide that request."; a refused reaction is logged with the user ID and request ID, never replied to. |
| Who can add an approver | The admin, directly (their own command, by ID taken from the verified sender) or by approving a request. Never an approver: `approver` is not decidable by one. |
| Identity of the added user | In B the ID is the sender's own `message.author.userId`, set by the platform. In A the ID comes from a replied-to message's `from.id`, a `text_mention` entity or a `<@U…>` in text; the reply confirms the display name so the admin sees whom they added. A bot account is refused (`is_bot` on Telegram, `isBot` on the author). |
| Single use | Unchanged: the claim is taken before the decision is applied and released if applying fails. Two approvers racing produce one decision. |
| Re-check | Membership is read on every reaction and command, so removing an approver stops their next decision. The admin check keeps its existing 30 s `get` cache. |
| Own request | An MCP request has no author: the stored fields are the thread and the message that triggered the turn, and the definition comes from the reviewed default-branch config, not from the requester. Version 1 does not block self-approval for `mcp`; recording a `requesterId` would need the dispatch payload or the poster to carry the author, which is out of scope. For a `user` request, `subjectId` is the requester, so if approvers ever decide `user` requests, an approver may not decide a request whose `subjectId` is their own ID (only the admin may). |
| Content | The DM text is unchanged: bot, repository, server, summary, never message content. The set stores IDs and display names only. |
| Audit | MCP approvals already store `{at, approver}`. The decision log line gains `approverId`. The denial record, today `true`, becomes `{at, approver}`; `isDenied` then tests presence. An approver entry stores `{name, at}` plus `approver` (the deciding or adding admin ID). Access approval entries gain an `approver` field only if access requests are opened to approvers. |
| Write access | The Lambda role may write the approvers path only; it cannot write the admin or the admin claim through that grant. A pull request cannot touch the set: it is in SSM, not in a repo. |

## 6. Bootstrapping and failure

| Case | Behavior |
|---|---|
| No approvers | The admin alone decides, as today. No migration: the key prefix is empty. |
| No admin on the platform | No request is raised, as today; the set is inert, `approver request` is answered with a fixed "no admin" line and CLI `add` refuses. `centaur admin remove` leaves the set in place; it applies again when an admin is set. |
| Stale approver ID (left the workspace, blocked the bot, never opened the DM on Telegram) | The DM to them fails and is logged by ID; the others still receive the request. The entry stays until the admin removes it. |
| Admin DM fails, an approver's succeeds | The request stands; an approver can decide it. |
| Everything unreachable | The request is removed and the turn sees `pending`, as for an unreachable admin. |
| A request pending when an approver is removed | Their DM still exists but their decision is refused. |
| Set at the cap when an `approver` request is approved | The decision is refused and the claim released; the admin removes someone first. |

## 7. Interaction with TTL, limits and the no-admin case

- The 7-day TTL and the single pending slot per subject are per request, not per recipient. An
  `approver` request expires like any other, and the denial record lasts 7 days.
- The hourly request limit is unchanged and still counts requests; recipients multiply DMs, not
  requests (see [section 4](#4-how-approvers-are-asked)).
- Raising the first request on a platform with an admin but no approvers sends one DM, byte for byte
  today's flow.
- With no admin the feature is off for that platform (above).

## 8. Group size

| Option | Assessment |
|---|---|
| No cap | A mistake or a script could make each MCP request fan out to a long list, and `list` becomes a review burden. |
| Cap 10 | Bounds DMs per request to 11 and the per-hour worst case to 110; comfortably above a household or small team. |
| Cap 20 | Matches the `mcp-approvals` server cap; worst case 210 DMs per hour. |

Recommendation: **10 approvers per connection** (the admin not counted), enforced when a request is
approved, by `add` and by the CLI; a larger set written by hand is read in full for authorization but
only the first 10 IDs in sorted order are sent the DM. The constant lives beside the other limits and
is easy to raise.

## 9. Docs and CLI impact

Each topic has one home; the other docs link to it.

| Topic | Home |
|---|---|
| Who may decide, fan-out, the `approver` kind, admin commands, layout | [plan.md](plan.md#access-requests) |
| The operator's how-to: powers, authorizing, listing, removing | [onboarding.md](onboarding.md#approvers) |
| `centaur approvers` | [cli.md](cli.md) |
| The Lambda's IAM statements | [deploy.md](deploy.md#iam) |
| MCP requests going to approvers | [mcp-approval.md](mcp-approval.md), [mcp.md](mcp.md#operator-policy) |
| Code conventions | AGENTS.md |

## Decisions

The recommendation is first in each item; the maintainer accepts or amends.

1. **Scope.** Approvers decide `mcp` requests only; `chat`, `user` and `approver` stay admin-only,
   behind a one-constant kind gate. Alternative: all kinds.
2. **Powers.** Decide requests of the allowed kinds, and leave; never manage others, claim admin or
   change config.
3. **Authorization (amended).** Chat is primary. A new `approver` request kind: an approved user DMs
   `/approver request` (Telegram) or `approver request` (Slack), the admin decides with 👍 or 👎, and
   only the admin can decide it. Second slice: the admin's `approver add|remove|list` (Telegram reply
   or numeric ID, Slack DM mention). The CLI offers `list`, `remove` and `add` as the operator
   fallback. No invite codes, no Slack slash command.
4. **Layout.** `bots/<bot>/platforms/<platform>/approvers/<userId>` holding the `encodeEntry` JSON; the
   admin stays in `/centaur/admin/<platform>` and is implicitly an approver. The receiver writes it, so
   the Lambda role gets Put and Delete on that path (deploy).
5. **Asking.** DM the admin and each approver for `mcp`; the first decision claims the request; other DMs
   are left alone. The message link is keyed `<channelId>:<messageId>`. A shared group chat is not built.
6. **Who may ask to be an approver.** Only an approved, unblocked user, in a DM; a stranger gets the
   normal access request. One pending slot per user, a 7-day denial record, and the shared hourly limit.
7. **Own request.** No self-approval block for `mcp` (a request has no author, and the definition
   comes from reviewed config); a block on `subjectId` for `user` requests if they are ever opened.
8. **No admin.** The set is inert and `request` and `add` refuse; no admin means no requests, as today.
9. **Cap.** 10 approvers per connection.
10. **Audit.** Log `approverId` on every decision, store `{at, approver}` in the denial record and an
    `approver` field in the set entry; the MCP approval record already has it.
11. **Access.** An approver is not an approved user; being one is required to ask, not granted by it.
12. **Removal.** Immediate: membership is read on every decision, with uncached `getByPath`. By the
    admin (`approver remove`, CLI) or by the approver (`approver leave`).

## Out of scope

- Approving `chat` and `user` access requests (Decision 1, later).
- A shared approvals group chat, Telegram inline buttons and editing the other DMs after a decision.
- Invite codes, Slack slash commands (manifest change and reinstall) and Telegram username
  resolution.
- A requester notion for MCP requests (author on the request).
- Quorum or two-person rules; per-server or per-kind approver lists; a per-kind hourly limit.
- Approvers across bots or platforms.

## Implementation map

| Part | Source |
|---|---|
| Set, cap, `mayDecide`, `recipientsFor`, `isUserId` | `src/lambda/approvers.ts` |
| Paths | `src/lambda/connection-paths.ts` (`approversPrefix`, `approverParameter`) |
| Decisions, the `approver` applier, audit and denial records | `src/lambda/access-decisions.ts`, `src/lambda/access-request-store.ts` |
| Fan-out and the `approver` request | `src/lambda/access-requests.ts`, `src/lambda/admin-channel.ts` |
| `request`, `leave`, `add`, `remove`, `list` | `src/lambda/approver-commands.ts`, reached from `src/lambda/admin-handlers.ts` (Telegram) and `src/lambda/message-handler.ts` (Slack) |
| IAM Put and Delete on the approvers path | `infra/centaur.yml` |
| CLI | `src/cli/commands/approvers.ts` |
| Not built | Slice 6, access requests for approvers: the kind list in `src/lambda/approvers.ts`, the fan-out, the self-approval rule for `user` requests and the `approver` field in access entries |
