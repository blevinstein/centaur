# Approval-required MCP servers

Design for a third outcome of the [operator policy](mcp.md#operator-policy): besides allow and deny,
a server can be allowed *once a human says yes*. This is a design; nothing here is built. Terms
(poster, admin channel, access request, state table) are defined in [plan.md](plan.md#access-requests),
[poster.md](poster.md) and [workflows.md](workflows.md).

## Summary of the design

- Cedar stays binary. The policy states the precondition ("permit when `context.approved`"); the
  runner evaluates it twice, with `approved` false and true, and derives the third outcome from the
  pair. One action, so every `forbid` (including the global ceiling) binds exactly as today.
- Asking reuses the [access request](plan.md#access-requests) machinery: the bot DMs the admin, who
  reacts 👍 or 👎 (or sends `/approve <id>`). The decision is stored per server definition.
- `prepare` asks at the start of a turn and runs the turn **without** the pending servers. If the
  agent cannot do the request without one, it **suspends**: the turn ends, the thread's marker stays
  put, and when the admin decides, the receiver re-dispatches an ordinary turn for the thread. The
  session is already saved by the existing `resume` machinery.
- No component waits. A wait of hours costs no runner minutes and no Lambda time.
- Server level only. Tool level is the same mechanism applied to `allowed_tools` entries, added later.

## Where a wait could live

Checked against [plan.md](plan.md) and [workflows.md](workflows.md):

| Component | Role | Limits that matter |
|---|---|---|
| Receiver Lambda | Webhooks, access decisions, `repository_dispatch` | Webhook answered within seconds (Slack requires 3 s; Telegram retries slow ones), and the stack's `Timeout` is 30 s. Never holds a turn. |
| Poster Lambda | Operations called by the runner through `aws lambda invoke` | Same function, 30 s timeout (15 minutes is only the platform maximum); the invoke is synchronous. |
| GitHub Actions job | **Runs the turn**: `claude-code-action`, MCP servers, `finish` | `timeout-minutes` (30 in the example workflows; GitHub hosted jobs cap at 6 hours). Holds the thread's `concurrency` group, in which GitHub keeps only the newest pending run. |

So the Lambda 15-minute limit does not bound a turn: turns run on the runner. A wait inside the
turn would be a poll loop on the runner made of short poster calls. It would consume the job's
`timeout-minutes`, bill minutes while a human is away, and block the thread's group. The backlog item
"long-running agent turns (>15 mins)" in [TODO.md](../TODO.md) appears to assume a Lambda limit that
does not apply; its real limits are `timeout-minutes` and cost (maintainer's call whether to reword
it). Approval waits must use neither, hence suspend and resume.

## Cedar: expressing the third outcome

Cedar returns only allow or deny, so any "third tier" is a convention over binary answers. What
`cedar-wasm` 4.14.0 (the pinned version) offers: `isAuthorized`, `isAuthorizedPartial`
(residual policies), `policyToJson` (exposes annotations), `validate` with a schema. Options:

| Option | Mechanism | Assessment |
|---|---|---|
| A. `approved` context attribute | One action, `context: { approved: Bool }`. A policy that needs a human says `when { context.approved }`. The runner evaluates with `false` and `true` | The policy file says what it means. A typo fails schema validation. A `forbid` on `UseServer` binds both evaluations, so the ceiling cannot be lifted and needs no extra scoping. |
| B. Second action `RequireApproval` | A permit on it means "ask" | A ceiling written `action == UseServer` does not stop the second action unless the runner checks it first or authors remember `action in [...]`. Two permits per server to keep in step. |
| C. Annotation `@approval("required")` | Runner maps determining policy ids to `policyToJson` annotations | Annotations are not validated: `@aproval` is a plain `permit`, which fails open. Ambiguous when an unannotated permit also matches. |
| D. Partial evaluation | Unknown `approved`; "needs approval" is a residual that is not a constant | Exposed by the bindings, but the outcome becomes an inference over a residual expression tree, and I did not exercise it. More machinery than the problem. |
| E. Outside Cedar | An approval list in config or SSM, checked after Cedar allows | The ceiling and the repo/global merge only cover the Cedar half; a second list outside policy review says which servers need a human. |

Recommendation: A. In `MCP_POLICY_SCHEMA`:
`action UseServer appliesTo { principal: Bot, resource: McpServer, context: { approved: Bool } };`.
`authorize` runs the merged policy set twice (`approved` false, then true). Semantics:

| Matching policies | `approved=false` | `approved=true` | Outcome |
|---|---|---|---|
| any `forbid` (either layer, including the global ceiling) | deny | deny | **deny** (`forbidden by policy ...`); nothing is asked |
| a `permit` not mentioning `approved` | allow | allow | **allow** |
| a `permit when { context.approved ... }` only | deny | allow | **approval required** |
| no `permit` | deny | deny | **deny** (`not permitted by any policy`) |
| allow at false, deny at true (a policy that gets *stricter* on approval) | allow | deny | **deny**: the true evaluation is a ceiling |

For *approval required*, the runner then consults the stored decision for this definition:

| Stored decision | Outcome |
|---|---|
| approved | **approved**: the server runs (the real request is evaluated with `approved: true`, which allows) |
| denied (7-day record) | **denied**: dropped, no new question |
| none, request pending | **pending**: dropped, no new question |
| none | ask the admin, then **pending** |

Because every `forbid` already denies at `approved=true`, approval can never lift a ceiling, and
re-evaluating policy every turn means removing the permit revokes an approval without touching the
record. Both layers may carry `when { context.approved }` permits: a repo asking for approval of its
own servers widens nothing, since a human still decides. Typical global default:

```cedar
// any server the ceiling lets through is usable after the admin approves it
permit(principal, action == Action::"UseServer", resource) when { context.approved };
```

`checkMcpPolicy` returns `{ issues, approvals }`, where `approvals` are the servers whose outcome is
*approval required*. `centaur config check` and `register` treat them as passing, with a notice in the
job summary. Existing policies are unchanged: none mentions `context`.

## What gets approved

An approval is for one **server definition**, not a name: the key is `<name>:<fingerprint>`, the
first 16 hex of the SHA-256 of the canonical JSON of `transport`, `url`, `command`, `args`, the
sorted `env` and `headers` keys (names and secret references, never values), plain `env` values, and
the `allowed_tools` entries naming that server. Editing any of them yields a new key and a new
question.

| Scope | Assessment |
|---|---|
| Per turn | Asks every turn. Too noisy. |
| Per thread | Repeats for each thread and scheduled prompt. |
| Per bot, persistent, until revoked | The bot is bound to one repo, so this is per repo. Matches access approvals; easy to list and revoke from the CLI. |

Recommendation: persistent per bot. The fingerprint makes it exactly what the admin saw.

## Suspend and resume

**When a turn suspends.** `prepare` asks for every approval-required server without a decision,
drops pending and denied servers from `mcp.json` and `--allowedTools`, and tells the agent in the
prompt: `MCP servers awaiting admin approval and unavailable this turn: linear (tools: ...). If you
cannot complete the request without one, return suspend_for with its name instead of working around
it.` The agent decides, because only it knows whether the request needs the server. `suspend_for` is a
new structured-output field (`replySchema`, `resultMessage`/`extractResult`, `docs/workflows.md`, per
AGENTS.md). `reply` still posts, so the user reads "waiting for the admin to approve linear".

Suspending is only for **chat turns**. It does not apply to:

- a slow tool call inside a running turn: the Claude process is alive and cannot be paused, so this is
  the long-running-turn problem, bounded by `timeout-minutes`;
- scheduled prompts and pull request comment turns in the first version: they run without the server
  and report which were pending (a scheduled prompt has no waiting human).

**What suspend does.** `finish` posts the reply, removes the 👀 reactions, saves the session (as for
every `resume` thread) and **does not advance the last-processed marker**, then calls the poster
`mcp-approvals` with `suspend: true` for the named servers. The job ends and the thread's concurrency
group is free, so later messages run normally (and see the same pending messages, still without the
server).

**Pending record.** Extends the access request (`kind: "mcp"`, state table, TTL 7 days like every
request):

| Field | Content |
|---|---|
| `subjectId` | `<name>:<fingerprint>` |
| `summary` | transport, host or command and args, secret names, allowed tools |
| `threadId`, `messageId` | the thread and the triggering message, from the turn's dispatch payload |
| `suspended` | set by `mcp-approvals` with `suspend: true`; absent when the agent worked without the server |

**Resume.** The decision arrives in the receiver as it does for access requests (reaction or
`/approve` / `/deny`, admin only, single-use claim). On approval the receiver writes the SSM record.
If `suspended`, it then sends a `repository_dispatch` of type `centaur-message` with the original
`{bot, thread_id, thread_key, message_id}`. This is a normal turn, so the payload, the three consumer
workflows and the concurrency group do not change. Because the marker was not advanced, the turn finds
the same pending messages; under `resume` it continues the saved session. On denial it dispatches the
same way so the agent answers without the server. If the dispatch fails the claim is released so the
decision can be retried, as access decisions already do.

**What the agent sees on resume.** The pending messages, its earlier session, and one prompt line:
`The admin approved MCP server linear; its tools are available this turn.` (or `...denied ...; answer
without it`). Context policies `fresh` and `transcript` have no session, but the pending messages and
the line are enough to redo the work.

**Idempotency and races.**

| Case | Behavior |
|---|---|
| Double approval, reaction plus `/approve` | The existing claim makes the decision single-use; one dispatch. |
| Thread moved on: a later message ran a turn before the decision | That turn already handled the pending messages (without the server) and advanced the marker. The resume turn finds nothing pending and exits as every empty turn does; the receiver's "approved, ask again" post tells the user the server is available. |
| Approved, then revoked or the permit removed before the turn | `prepare` re-evaluates policy and record: the server is dropped and pending again, and the prompt says so. `suspend_for` is ignored for servers whose request is not pending, so a turn cannot loop. |
| Definition edited meanwhile | New fingerprint, so the old approval does not apply; a new question is asked. |
| Request expires (7 days) | No dispatch. The messages stay pending until the next message in the thread. |
| Two threads wait on one server | One pending slot per `<name>:<fingerprint>`. Approval dispatches only the thread that created the request; others see the stored approval from their next turn. |

**Versus plain async ("ask again").** Async needs the user to repeat the request after approval and
leaves the first answer degraded. Suspend/resume costs one structured field, the `suspended` flag and
one dispatch from the decision handler, and delivers the original request without user effort. Plain
async is what happens when the agent does not suspend, so it stays as the fallback rather than a
second mechanism.

**Recommendation: suspend/resume is the primary design**, async-with-nudge is its no-suspend path,
and in-turn waiting is rejected (see [Where a wait could live](#where-a-wait-could-live)).

**Long-running turns.** Suspend/resume removes approval waits from the runner and the Lambda
altogether, and the same shape (end the turn, store state, re-dispatch) is how any later
human-in-the-loop pause would work. It does not help turns that are slow because an MCP tool call or
the agent's own work takes long; those are bounded by `timeout-minutes` and the config's budget
limits, and would need a different design (mid-turn checkpointing), which is not proposed here.

## The request and the decision record

Everything is stored by the poster, which already holds the admin channel, the state table and the
bot's SSM paths. New poster operation (OIDC token, so the repository comes from the verified claim;
strict schema):

| `operation` | Fields | Result |
|---|---|---|
| `mcp-approvals` | `token`, `bot`, `threadId`, `messageId`, `servers`: `[{ name, fingerprint, summary }]` (1 to 20), optional `suspend` (boolean) | `{ servers: { <name>: "approved" \| "pending" \| "denied" } }` |

For each server it reads the decision; with none and no pending request it creates one and DMs the
admin; with `suspend` it marks the request `suspended`. `summary` is rendered by the runner from
validated config (secret names, never values) and only length-limited by the Lambda; the fingerprint
is part of the key, so a summary cannot approve a different definition than the one the runner starts,
and the runner re-derives it every turn.

| Where | Key | Content |
|---|---|---|
| SSM | `bots/<bot>/mcp-approvals/<name>/<fingerprint>` | JSON: time, approver user ID. Presence means approved. Listable and revocable from the [CLI](cli.md). |
| State table (TTL 7 days) | `access-request:<id>`, `access-subject:mcp:<name>:<fingerprint>`, `access-request-message:<message id>`, `access-request-claim:<id>` | As for access requests; the request carries the fields above. |
| State table (TTL 7 days) | `mcp-denied:<name>:<fingerprint>` | Written on denial; reported as `denied` until it expires. |

Denial is a TTL record, so a mistaken 👎 heals itself and nothing needs a CLI. Existing limits apply:
one pending request per subject, 10 new requests per bot per hour, 7-day expiry. The DM names the bot,
repository and summary, never message content.

## Asking the human: reactions or buttons

| Option | Assessment |
|---|---|
| A. Reactions 👍 / 👎 on the DM, `/approve <id>` fallback | Built and tested for access requests (`AdminChannel`, `access-decisions.ts`); works on Telegram and Slack; restricted to the admin's user ID on that DM. |
| B. Telegram inline buttons | Better on mobile, but needs `callback_query` handling and a Slack equivalent: a second decision path to secure. |

Recommendation: A. Buttons can be added to `AdminChannel` later; both feed `claimDecision`.
`access-decisions.ts` needs one dispatch on `request.kind` for `mcp`. Only the platform admin
approves.

## Tool-level approval

Tool calls are checked by the separate `CallTool` action, which `prepare`'s PreToolUse hook
evaluates per call (see [Tool-call policy](mcp.md#tool-call-policy)). Approval stays at server level:
`McpTool` resources exist only per call, and wildcards like `mcp__linear__*` cannot be enumerated
without starting the server. Servers with dangerous tools list them explicitly in `allowed_tools`,
which is in the fingerprint, so adding one re-asks.

## Failure and security

- Fail closed: a poster failure or an unparseable answer is `pending`, never `approved`. The turn runs
  without the server and does not suspend (nothing is pending to resume from). This differs from a
  policy fetch failure, which fails the turn: a missing approval only removes a capability, while a
  missing policy removes the guard.
- A pull request that adds a server reaches a turn only after merge (default-branch config), then
  needs the admin: a second control behind review of the policy file.
- No admin on the bot's platform: nothing can be asked; treat as `denied` without a record and log it.
- Secrets never appear in the DM, the fingerprint input or any record, only names.

## Out of scope

- Tool-level rules and wildcard enumeration.
- Approval by anyone other than the platform admin.
- Waiting inside a turn, and mid-turn checkpointing for slow tools.
- Suspending scheduled prompts and pull request comment turns.
- Approving a secret's value or scope; the caller `env:` stays the allowlist.
- Time-based expiry of approvals; revocation is explicit.

## Implementation plan

1. **Cedar**: add `context: { approved: Bool }` to `UseServer` in `MCP_POLICY_SCHEMA`; evaluate twice
   in `authorize` and return `{ issues, approvals }`; fingerprint helper. Tests for every row of both
   tables, including a global `forbid` over a repo `when { context.approved }` permit and a policy
   stricter on approval. `config check` and `register` print approval servers.
2. **Request kind and decisions**: `mcp` kind in the access request store (fields above), admin DM
   text, `fromReaction` / `/approve` / `/deny` dispatch, SSM write, `mcp-denied` record, "approved"
   post, and the re-dispatch when `suspended`. IAM for `bots/*/mcp-approvals/*` (`yarn lint:cfn`).
3. **Poster `mcp-approvals`**: strict schema, OIDC repository check, read-or-ask, `suspend`. Document
   in [poster.md](poster.md).
4. **`prepare`**: call it, drop non-approved servers from `mcp.json` and `--allowedTools`, add the
   prompt lines (pending, approved, denied); a poster failure maps to `pending`. Fakes updated per
   AGENTS.md.
5. **Suspend in `finish`**: the `suspend_for` field in the three places AGENTS.md names, skipping the
   marker advance, and the `suspend: true` poster call. Ignore `suspend_for` for servers that are not
   pending.
6. **CLI**: `centaur mcp approvals <bot>` (list) and `revoke <bot> <name>`.
7. **Docs and live check**: fold into [mcp.md](mcp.md#operator-policy), [plan.md](plan.md#access-requests)
   and [workflows.md](workflows.md); verify with one remote server: ask, suspend, 👍, resume turn
   answers the original request, edit the URL and see a new question.

Steps 1 to 4 alone give async "ask again"; 5 adds suspend/resume; 6 is optional.

## Decisions

The maintainer accepts or amends each recommendation.

1. **Cedar shape.** `context.approved` evaluated twice (A), versus a second action, annotations,
   partial evaluation or a list outside Cedar. Recommendation: A.
2. **Waiting.** Suspend and resume, versus a poll loop on the runner, versus async with a nudge only.
   Recommendation: suspend/resume as the primary design, with async as its no-suspend path.
3. **Who decides to suspend.** The agent, through `suspend_for`, versus always suspending when a server
   is pending. Recommendation: the agent, since only it knows if the request needs the server.
4. **Resume mechanism.** An ordinary `centaur-message` dispatch with the marker left in place, versus
   a new event type carrying the session. Recommendation: the ordinary dispatch.
5. **Scope of suspend.** Chat turns only at first. Recommendation: yes.
6. **Approval scope.** Persistent per bot and fingerprinted definition. Recommendation: yes.
7. **Channel.** Reactions with `/approve` fallback, versus buttons. Recommendation: reactions.
8. **Granularity.** Server only. Recommendation: server only.
9. **Denial.** A 7-day TTL record, versus a permanent block. Recommendation: TTL record.
10. **Approval-call failure.** Run without the server, versus fail the turn. Recommendation: run
    without it.
11. **Long-running backlog item.** Reword it to name `timeout-minutes` and cost as the real limits.
    Recommendation: yes, maintainer's call.
