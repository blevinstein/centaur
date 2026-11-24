# Approval-required MCP servers

Design for a third outcome of the [operator policy](mcp.md#operator-policy): besides allow and deny,
a server can be allowed *once a human says yes*. Implemented; this page is the design reference (the
[implementation map](#implementation-map) points at the code), and the operator's view is in
[mcp.md](mcp.md#operator-policy). Terms
(poster, admin channel, access request, state table) are defined in [plan.md](plan.md#access-requests),
[poster.md](poster.md) and [workflows.md](workflows.md).

## Summary of the design

- Cedar stays binary. The policy states the precondition ("permit when `context.approved`"); the
  runner evaluates it twice, with `approved` false and true, and derives the third outcome from the
  pair. One action, so every `forbid` (including the global ceiling) binds exactly as today.
- Asking reuses the [access request](plan.md#access-requests) machinery: the bot DMs the admin and
  each [approver](approvers.md); the first of them to react 👍 or 👎 (or send `/approve <id>`)
  decides. The decision is stored per server definition.
- `prepare` asks at the start of a turn and runs the turn **without** the pending servers. If the
  agent cannot do the request without one, it **suspends**: the turn ends, the thread's marker stays
  put, and when the admin or an approver decides, the receiver re-dispatches an ordinary turn for the thread. The
  session is already saved by the existing `resume` machinery.
- No component waits for hours, and `prepare` never waits at all. It asks the poster once per turn and uses the answer as is: a decision already stored is used by that turn, and one that arrives later is seen by the next turn (a suspended thread is re-dispatched by the receiver).
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
`timeout-minutes`, bill minutes while a human is away, and block the thread's group. The limits on a long turn are
`timeout-minutes` and cost, not a Lambda limit. Approval waits must use neither, hence suspend and
resume.

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
| approved | **approved**: the server runs |
| denied (7-day record) | **denied**: dropped, no new question |
| none, request pending | **pending**: dropped, no new question |
| none | ask the admin and approvers, then **pending** |

Because every `forbid` already denies at `approved=true`, approval can never lift a ceiling, and
re-evaluating policy every turn means removing the permit revokes an approval without touching the
record. Both layers may carry `when { context.approved }` permits: a repo asking for approval of its
own servers widens nothing, since a human still decides. Typical global default:

```cedar
// any server the ceiling lets through is usable after the admin approves it
permit(principal, action == Action::"UseServer", resource) when { context.approved };
```

`evaluateMcpPolicy` returns `{ issues, approvals }`, where `approvals` are the servers whose outcome is
*approval required*. `centaur config check`, `register` and `prepare` treat them as passing, with a
notice (`::notice::` in a run, `Notice:` in the CLI). Policies that never mention `context` behave
as a plain allow or deny.

## What gets approved

An approval is for one **server definition**, not a name: the key is `<name>:<fingerprint>`, the
first 16 hex of the SHA-256 of the canonical JSON of `transport`, `url`, `command`, `args`, `env`
and `headers` (plain values and secret references, never secret values), and the `allowed_tools`
entries naming that server. Editing any of them yields a new key and a new question.

| Scope | Assessment |
|---|---|
| Per turn | Asks every turn. Too noisy. |
| Per thread | Repeats for each thread and scheduled prompt. |
| Per bot, persistent, until revoked | The bot is bound to one repo, so this is per repo. Matches access approvals; easy to list and revoke from the CLI. |

Recommendation: persistent per bot. The fingerprint makes it exactly what the admin saw.

## Suspend and resume

**When a turn suspends.** `prepare` asks for every approval-required server without a decision,
drops pending and denied servers from `mcp.json` and `--allowedTools`, and tells the agent in the
prompt (the wording and the field are in [workflows.md](workflows.md#approval-required-mcp-servers)).
The agent decides, because only it knows whether the request needs the server. `reply` still posts,
so the user reads that the agent is waiting for an approval.

Suspending is only for **chat turns that reply in an existing thread**. It does not apply to:

- a slow tool call inside a running turn: the Claude process is alive and cannot be paused, so this is
  the long-running-turn problem, bounded by `timeout-minutes`;
- scheduled prompts, `/new` turns and pull request comment turns: they run without the server and
  the prompt names the pending ones, and `suspend_for` is not offered. A turn with a thread (a
  persistent scheduled prompt, `/new`, a comment turn) still raises the request for the admin; a
  scheduled prompt without a persistent thread asks `mcp-approvals` without `threadId` and
  `messageId`, which only reads stored decisions: it uses an approved server but cannot request one.

**When a turn does not suspend.** `prepare` asks the poster once per turn and uses the answer as is: a server whose decision is already stored as approved runs in that turn and nothing is dropped, asked of the agent or suspended. A request is never polled; a decision that arrives later is seen by the next turn (or, for a suspended thread, by the re-dispatch).

**What suspend does.** `finish` posts the reply, removes the 👀 reactions, saves the session (as for
every `resume` thread) and **does not advance the last-processed marker**, then calls the poster
`mcp-approvals` with `suspend: true` for the named servers. The job ends and the thread's concurrency
group is free, so later messages run normally (and see the same pending messages, still without the
server). The marker stays only if the `suspend: true` call succeeds; if it fails (or `finish` has no
OIDC token), `finish` logs the error type and advances the marker as for any turn, because no
decision will resume the thread. Only servers that were pending when `prepare` ran count; other
names in `suspend_for` are ignored. A valid `suspend_for` without a `reply` is accepted, and `finish`
posts a fixed waiting line naming the servers.

**Pending record.** Extends the access request (`kind: "mcp"`, state table, TTL 7 days like every
request):

| Field | Content |
|---|---|
| `subjectId` | `<name>:<fingerprint>` |
| `summary` | transport, host or command and args, secret names, allowed tools |
| `threadId`, `messageId` | the thread and the triggering message, from the turn's dispatch payload |
| `suspended` | set by `mcp-approvals` with `suspend: true`; absent when the agent worked without the server |

**Resume.** The decision arrives in the receiver as it does for access requests (reaction or
`/approve` / `/deny`, from the admin or an approver, single-use claim). On approval the receiver writes the SSM record.
If `suspended`, it then sends a `repository_dispatch` of type `centaur-message` with the original
`{bot, thread_id, thread_key, message_id}`. This is a normal turn, so the payload, the three consumer
workflows and the concurrency group do not change. Because the marker was not advanced, the turn finds
the same pending messages; under `resume` it continues the saved session. On denial it dispatches the
same way so the agent answers without the server. If the dispatch fails the claim is released so the
decision can be retried, as access decisions already do.

**What the agent sees on resume.** The pending messages and its earlier session. After an approval
the server is simply running with its tools; after a denial the prompt says `MCP server linear was
denied by the admin; answer without it.` Context policies `fresh` and `transcript` have no session,
but the pending messages are enough to redo the work. The receiver also posts in the thread that the
server was approved or denied.

**Idempotency and races.**

| Case | Behavior |
|---|---|
| Double approval, reaction plus `/approve` | The existing claim makes the decision single-use; one dispatch. |
| Thread moved on: a later message ran a turn before the decision | That turn already handled the pending messages (without the server) and advanced the marker. The resume turn finds nothing pending and exits as every empty turn does; the receiver's "approved, ask again" post tells the user the server is available. |
| Approved, then revoked before the turn | `prepare` reads the record: the server is dropped and pending again, and the prompt says so. The decision released the pending slot, so the next turn asks the admin again. `suspend_for` is ignored for servers that were not pending, so a turn cannot loop. |
| The permit removed before the turn | `prepare` evaluates policy first: the server is denied by policy and the turn fails like any denied server, whatever the record says. |
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
| `mcp-approvals` | `token`, `bot`, optional `threadId` and `messageId` (together; without them the call is read-only), `servers`: `[{ name, fingerprint, summary }]` (1 to 20), optional `suspend` (boolean) | `{ servers: { <name>: "approved" \| "pending" \| "denied" } }` |

For each server it reads the decision (one short, stateless call, so the Lambda's 30 s timeout never matters and the operation takes no wait parameter); with none and no pending request it creates one and DMs the
admin and each approver; with `suspend` it marks the request `suspended`. `summary` is rendered by the runner from
validated config (secret names, never values) and only length-limited by the Lambda; the fingerprint
is part of the key, so a summary cannot approve a different definition than the one the runner starts,
and the runner re-derives it every turn.

| Where | Key | Content |
|---|---|---|
| SSM | `bots/<bot>/mcp-approvals/<name>/<fingerprint>` | JSON: time, approver user ID. Presence means approved. Listable and revocable from the [CLI](cli.md). |
| State table (TTL 7 days) | `access-request:<id>`, `access-subject:mcp:<name>:<fingerprint>`, `access-request-message:<channel id>:<message id>`, `access-request-claim:<id>` | As for access requests; the request carries the fields above. |
| State table (TTL 7 days) | `denied:mcp:<name>:<fingerprint>` | Written on denial; reported as `denied` until it expires. |

Denial is a TTL record, so a mistaken 👎 heals itself and nothing needs a CLI. A repeated read of a pending request neither creates nor re-sends it. Existing limits apply:
one pending request per subject, 10 new requests per bot per hour, 7-day expiry. The DM names the bot,
repository and summary, never message content.

## Asking the human: reactions or buttons

| Option | Assessment |
|---|---|
| A. Reactions 👍 / 👎 on the DM, `/approve <id>` fallback | Built and tested for access requests (`AdminChannel`, `access-decisions.ts`); works on Telegram and Slack; restricted to the admin and the bot's approvers, on their own DM. |
| B. Telegram inline buttons | Better on mobile, but needs `callback_query` handling and a Slack equivalent: a second decision path to secure. |

Recommendation: A. Buttons can be added to `AdminChannel` later; both feed `claimDecision`.
`access-decisions.ts` dispatches on `request.kind` to the `mcp` applier. The platform admin and the
bot's [approvers](approvers.md) decide `mcp` requests; the other kinds stay with the admin.

## Tool-level approval

An `McpTool` resource would let policy say "reads are allowed, `delete_issue` needs approval";
enforcement is the same drop-from-`allowed_tools` step. Costs: a second resource type, wildcards like
`mcp__linear__*` cannot be enumerated without starting the server, and the fingerprint needs per-tool
keys. Recommendation: server level only. Servers with dangerous tools list them explicitly in
`allowed_tools`, which is in the fingerprint, so adding one re-asks.

## Failure and security

- Fail closed: a poster failure or an unparseable answer is `pending`, never `approved`. The turn runs
  without the server and does not suspend (nothing is pending to resume from). This differs from a
  policy fetch failure, which fails the turn: a missing approval only removes a capability, while a
  missing policy removes the guard.
- A pull request that adds a server reaches a turn only after merge (default-branch config), then
  needs the admin or an approver: a second control behind review of the policy file.
- No admin on the bot's platform: nothing can be asked; treat as `denied` without a record and log it.
- Secrets never appear in the DM, the fingerprint input or any record, only names.

## Out of scope

- Tool-level rules and wildcard enumeration.
- Approval by anyone other than the platform admin and its approvers.
- Waiting for a human inside a turn, and mid-turn checkpointing for slow tools.
- Suspending scheduled prompts and pull request comment turns.
- Approving a secret's value or scope; the caller `env:` stays the allowlist.
- Time-based expiry of approvals; revocation is explicit.

## Implementation map

| Part | Where |
|---|---|
| Policy: `context.approved`, the two evaluations, `approvals` | `src/config/mcp-policy.ts` (`evaluateMcpPolicy`), `MCP_POLICY_SCHEMA` in `src/config/mcp-policy-schema.ts`, `src/workflows/mcp-policy-check.ts` (`enforceMcpPolicy`), `centaur config check` in `src/cli/commands/config.ts` |
| Fingerprint and key | `mcpApprovalKey` in `src/config/mcp-fingerprint.ts` |
| Request kind, decisions, records | `src/lambda/access-request-store.ts`, `src/lambda/access-requests.ts` (`createMcpApprovalRequester`), `src/lambda/access-decisions.ts` (`applyMcp`), `infra/centaur.yml` (IAM for `bots/*/mcp-approvals/*`); [plan.md](plan.md#access-requests) |
| Poster operation | `src/lambda/mcp-approvals.ts`; [poster.md](poster.md#mcp-approvals) |
| `prepare` and `askApprovals` | `src/workflows/mcp-approval.ts`, wired in `src/workflows/prepare.ts`; the prompt section is `mcpApprovalSection` in `src/workflows/prompt.ts` |
| `suspend_for` and `finish` | `replySchema` in `src/workflows/prompt.ts`, `resultMessage` and `extractResult` in `src/workflows/finish.ts`, `suspendForApprovals` in the same file; [workflows.md](workflows.md#approval-required-mcp-servers) |
| CLI | `src/cli/mcp-approvals.ts`, `src/cli/commands/mcp.ts`; [cli.md](cli.md#centaur-mcp-approvals-bot) |

## Decisions (accepted)

The maintainer accepted every recommendation as written.

1. **Cedar shape.** `context.approved` evaluated twice (A), versus a second action, annotations,
   partial evaluation or a list outside Cedar. Accepted: A.
2. **Waiting.** Suspend and resume, versus a poll loop on the runner, versus async with a nudge only.
   Accepted: suspend/resume as the primary design, with async as its no-suspend path.
3. **Who decides to suspend.** The agent, through `suspend_for`, versus always suspending when a server
   is pending. Accepted: the agent, since only it knows if the request needs the server.
4. **Resume mechanism.** An ordinary `centaur-message` dispatch with the marker left in place, versus
   a new event type carrying the session. Accepted: the ordinary dispatch.
5. **Scope of suspend.** Chat turns only at first. Accepted.
6. **Approval scope.** Persistent per bot and fingerprinted definition. Accepted.
7. **Channel.** Reactions with `/approve` fallback, versus buttons. Accepted: reactions.
8. **Granularity.** Server only. Accepted.
9. **Denial.** A 7-day TTL record, versus a permanent block. Accepted: TTL record.
10. **Approval-call failure.** Run without the server, versus fail the turn. Accepted: run without it.
11. **Long-running backlog item.** Reword it to name `timeout-minutes` and cost as the real limits.
    Accepted (a TODO.md edit, separate from this design).
