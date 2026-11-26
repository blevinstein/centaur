# MCP allowlist entries

Status: **accepted**, all nine decisions; the outcome is that no allowlist is built and the
[permit cookbook](mcp.md#permit-cookbook) ships instead (implemented). This is the design behind the
former TODO.md item "Explore a way to update the MCP policy by adding entries to an allowlist". It builds on the
[operator policy](mcp.md#operator-policy) and on [approval-required servers](mcp-approval.md), and
the [approvers](approvers.md) decide the requests it mentions. Terms (fingerprint, approval key,
ceiling, `context.approved`) are defined there.

## Context

Today the operator allows an MCP server by editing a Cedar file: the repo's
`.centaur/mcp-policy.cedar` (read from the default branch, reviewed like any change) or the global
`infra/mcp-policy.cedar` (shipped by a deploy). The wish is to allow servers without hand-editing
Cedar, with some generalization: a server by name, by URL or host pattern, or a tool within it.

What already exists and overlaps:

| Mechanism | What it allows | Who adds it | Stored |
|---|---|---|---|
| Repo `permit` | Any shape Cedar can state: name, host, URL pattern, command, exact argument, `pinned` | Anyone who can merge to the default branch (review is the control) | `.centaur/mcp-policy.cedar` |
| Global `permit` | The same, for every registered repo | The deployer, through a deploy | `infra/mcp-policy.cedar` |
| `permit ... when { context.approved }` plus an approval | One server definition (`<name>:<fingerprint>`), after a human says yes | The admin or an approver, by reaction or `/approve` | `bots/<bot>/mcp-approvals/<name>/<fingerprint>` |
| `forbid` (either layer) | Nothing; wins over every permit and over every approval | Same as the layer it is in | Same |

So the approval record is already a persistent, revocable, per-bot allow, chosen at runtime by a
human with no Cedar edit. What it needs is a `permit when { context.approved }` somewhere, and the
documented global default
(`permit(principal, action == Action::"UseServer", resource) when { context.approved };`) supplies it
for every server the ceiling lets through. With that one global line, "the operator allows a server"
is already a chat reaction, and the ceiling still binds. The pinned-server rule is the ceiling's
`resource.pinned` clause plus the documented "allow any pinned local server" permit.

### What an allowlist would add beyond the approval record

Only these, and each is separable:

1. **Pre-approval without a turn.** An approval is created by the first turn that uses the server.
   An operator who knows the server they want cannot grant it ahead of that turn.
2. **Approvals that outlive an edit.** The fingerprint covers URL, command, arguments, env and
   header entries and the `allowed_tools` entries, so any edit (including a version bump) asks
   again. An allowlist entry could say "this host" or "this package at any version" instead.
3. **Naming the generalization without writing Cedar.** `centaur mcp allow my-bot host
   api.example.com` instead of a `permit` with `resource.host == ...`.
4. **A tool within a server.** `allowed_tools` already names tools and is part of the fingerprint.
   Tool-level policy belongs to [mcp-tool-policy.md](proposals/mcp-tool-policy.md) (`CallTool`), not here.

Items 2 and 3 are the ones that cost something: they move a decision about *what may run with the
job's secrets* out of a reviewed file into a store the admin edits at runtime, and they widen what a
single human reaction grants.

## Summary of the design

Decided: **do not build a new allowlist store or entry kinds.** Cover the need with what exists
and one small, optional CLI addition:

- A **cookbook of generalized permits** in [mcp.md](mcp.md#permit-cookbook): by name, by
  host (`resource.host == ...` or `like`), by URL pattern, by package name with `pinned`, each with
  and without `context.approved`. This answers "some level of generalization" in Cedar, reviewed
  like any policy change.
- Recommend the global `permit ... when { context.approved }` default for deployments that want
  chat-driven allowing, so no one edits Cedar to allow one more server.
- `centaur mcp approve <bot> <server>` (pre-approval of the exact definition in the default-branch
  config), the only item above that approvals cannot do. It writes the existing record, so no new
  storage, no new evaluation path.
- Keep generalized, runtime-editable allows (any version, any server on a host) out: they defeat the
  fingerprint and the pinning rule, and they are what a reviewed `permit` is for.

The least risky shape, if an allowlist is ever wanted after all, is kept under
[If built anyway](#if-built-anyway) as the documented alternative.

## Decisions

Each carries a recommendation.

### 1. Build an allowlist at all

| Option | Assessment |
|---|---|
| A. Do not build; cookbook plus global `context.approved` default plus (optionally) `centaur mcp approve` | Everything the existing mechanisms cover stays reviewable in one place; no new record type, evaluation path, IAM or CLI surface to audit. |
| B. Per-bot allowlist records evaluated by the runner and fed to Cedar as a context attribute | Lets the admin generalize at runtime; adds a second source of "allowed" next to Cedar, a new IAM path and a larger blast radius per reaction. |
| C. Edit the repo policy file from the CLI or chat (generate a pull request) | A reviewed change in the end, but the agent or CLI authoring Cedar text is the hand-rolled generation this item wants to avoid, and the review step is exactly what A keeps. |

Recommendation: **A.** The approval record plus a `context.approved` permit already is a persistent
allow chosen by a human; generalization is a policy edit that should be reviewed.

### 2. Who may add an entry

| Option | Assessment |
|---|---|
| A. Platform admin and [approvers](approvers.md), through a decision (as for approvals) | Existing path (`claimDecision`, single-use claim, `mayDecide`); exactly the people already trusted with `mcp` requests. |
| B. A reviewed change to a policy file | Existing path; the only one that can generalize. |
| C. Anyone with AWS access, by writing SSM directly | Possible today; not a feature. |

Recommendation: **exact definitions by A (as today), generalizations only by B.** A reaction should
grant what the DM showed, which is one definition. Anything broader than what a DM summary can show
is a reviewed file change, and the admin, not the approver set, is the person who can also add a
permit to the global file by a deploy.

### 3. Where it is stored

| Option | Assessment |
|---|---|
| A. Repo policy on the default branch | Per consumer repo, reviewed, already enforced everywhere; the right home for generalized allows. |
| B. Global policy | Deployer-wide; right for a ceiling and for the `context.approved` default; a deploy per change. |
| C. Per-bot record (`bots/<bot>/mcp-approvals/...`) | Right for an exact, human-chosen, revocable decision; wrong for patterns, since the key is a fingerprint. |

Recommendation: **generalized allows live in the repo policy (A) or the global policy (B); exact
decisions in the existing per-bot record (C).** No new location.

### 4. Composition with the ceiling and with `context.approved`

Unchanged: one merged policy set, any `forbid` wins in both evaluations, an approval never lifts a
ceiling, and a permit without `context.approved` allows outright. A generalized permit written in
the cookbook can carry `context.approved` to mean "this class of server, but a human confirms each
definition". Removing the permit removes the allow whatever records exist (policy is re-evaluated
every turn). Recommendation: **keep, and do not introduce any allow that bypasses Cedar** (the
"outside Cedar" option E already rejected in [mcp-approval.md](mcp-approval.md#cedar-expressing-the-third-outcome)).

### 5. How general may an entry be before it needs more than one approval

| Generality | Mechanism | Approvals needed |
|---|---|---|
| One definition (`<name>:<fingerprint>`) | Approval record | One approver decision (today) |
| One server name, any edit | Permit on `resource` name in Cedar, with `context.approved` | A reviewed policy change, then one decision per definition |
| A host or URL pattern | Permit on `resource.host` or `resource.url like ...` | A reviewed policy change; add `context.approved` to keep a human in the loop |
| Any version of a package | Rejected as an entry; see decision 7 | n/a |
| Any server on any host | Never an entry | Only the global default permit, set by a deploy |

Recommendation: **a reaction grants only the exact definition shown. Anything broader is a
reviewed Cedar permit, which already needs a change review, and a "second approval" is that
review.** Do not add a tier where two approvers must agree; the review gate is the second control.

### 6. Listing, revoking and auditing

`centaur mcp approvals <bot>` and `centaur mcp revoke <bot> <server> [--fingerprint <hex>]` already
list and revoke approvals and print what they remove; each decision logs `approverId` and the record
holds `{time, approver}` ([approvers.md](approvers.md)). Generalized permits are audited by the
default branch's git history of `.centaur/mcp-policy.cedar` (and `register`'s job summary lists
the servers). Recommendation: **no new listing or revoke commands.** Optionally, `centaur mcp
approvals` can print, per approved record, whether the current policy still permits it, so a stale
approval (its permit removed) is visible; this is a read of the policy `config check` already
fetches.

### 7. Interaction with the pinned-server rule (`isPinned`)

The ceiling forbids a stdio server unless `pinned`: its first non-flag argument is an exact registry
version or a full 40-hex commit SHA. An "any version of this package" entry cannot coexist with that:
it is either ignored (the ceiling still forbids the unpinned `pkg@latest`) or, if it matched pinned
versions only, equals a Cedar permit on the package name plus `pinned`, which a repo can already write.
Recommendation: **no "any version" entry; the supported generalization is `pinned` plus a name or
source in a reviewed permit** (the git-source example in [mcp.md](mcp.md#operator-policy)). A new
pinned version still asks once per definition when the permit carries `context.approved`, which is
the point of pinning: each content change is seen by a human.

### 8. Tool-level entries

Out of scope here. `allowed_tools` is in the fingerprint, so changing the tools of an approved
server asks again; per-call restrictions are the `CallTool` design in
[mcp-tool-policy.md](proposals/mcp-tool-policy.md). Recommendation: **do not add a tool entry kind.**

### 9. The small addition: `centaur mcp approve`

`centaur mcp approve <bot> <server> [--root <dir>] [--global-policy <path>] --yes` reads the default-branch
config of the bot's repository, computes `mcpApprovalKey` for the `mcp_servers` entry `<server>`, checks the policy outcome is
*approval required* (not denied by a `forbid`, not already allowed), and writes the SSM record with the CLI
caller as approver. It never accepts a fingerprint or a definition as flags, so the operator
approves exactly what is merged. Recommendation: **build it as a separate, optional follow-up; it
is the only gap the approval record cannot fill.** Built; see [cli.md](cli.md#centaur-mcp-approve-bot-server---yes).

## If built anyway

Only if decision 1 is amended to option B; not planned. The least risky shape:

- Record: `bots/<bot>/mcp-allow/<id>`, JSON `{ kind: "name" | "host" | "package", value, at, approver }`,
  hard cap 20 per bot, IAM scoped to that path as for approvals.
- Evaluation: the runner computes a boolean `context.allowlisted` per server from the records and
  passes it as a second context attribute, so Cedar still decides, a global `forbid` still wins, and
  a permit must say `when { context.allowlisted }` to honor it. No permit mentions it, no allow.
- Kinds: `name` (the server name), `host` (exact host, no wildcard), `package` (exact package name,
  only matching `pinned` arguments, so the ceiling is unaffected). No URL globs, no "any".
- Adding: only the admin, through the existing request path; never an approver, never from the
  agent. Revoke and list: `centaur mcp allow|allowed|unallow <bot>`.
- Audit: the same fields as approvals, plus a one-line notice in `register`'s summary naming each
  matching entry.

This is roughly the size of the approval feature again (schema, evaluation, poster or CLI writer, IAM,
docs, tests), to add runtime generalization the repo policy already provides with review.

## Failure and security

- A runtime store that widens matching (host, package) lets one reaction allow a class of servers
  that then run with the job's secrets; the fingerprint is what makes an approval "exactly what the
  admin saw", and a class entry gives that up.
- A read failure of any record is treated as not allowed, as for approvals.
- Entries never hold secrets, only names and host or package strings.
- The ceiling is never configurable at runtime.

## Out of scope

- Tool-level and argument-level allows ([mcp-tool-policy.md](proposals/mcp-tool-policy.md)).
- Time-based expiry of approvals or entries.
- Letting the agent, a pull request or a chat message other than a decision add an entry.
- Allowing anything the global ceiling forbids.

## Follow-ups

`centaur mcp approve` (decision 9) is built; where its parts live:

| Part | Where |
|---|---|
| Key for the named server from the default-branch config | `mcpApprovalKey` in `src/config/mcp-fingerprint.ts`; config and policy reads as in `src/workflows/mcp-policy-check.ts` |
| Outcome check (*approval required*) | `evaluateMcpPolicy` in `src/config/mcp-policy.ts` |
| Writing the record | the CLI's `ParameterStore` (`src/cli/parameter-store.ts`) at `bots/<bot>/mcp-approvals/<name>/<fingerprint>`, beside `src/cli/mcp-approvals.ts` |
| Command | `src/cli/commands/mcp.ts`, `src/cli/mcp-approve.ts` |

Its tests: writes the record for an approval-required server using `FakeParameterStore`; refuses a
server denied by a `forbid`, one already allowed outright, one not in the config, and an unpinned
stdio server; a second call is idempotent; `centaur mcp approvals` lists it and `centaur mcp revoke`
removes it. The optional stale-approval annotation (decision 6) is not planned.

The cookbook is tested by `test/mcp-cookbook.test.ts`, which extracts each snippet from
[mcp.md](mcp.md#permit-cookbook) and evaluates it through `evaluateMcpPolicy`. Add a snippet by
giving its `cedar` block a `// cookbook: <id>` first line and a case in that test.

## Open questions (answered by acceptance)

1. Is pre-approval before the first turn (decision 9) worth a command, or is waiting for the first
   request fine?
2. Does any deployment want the global `context.approved` default now, or does each repo keep
   writing its own permits?
3. Is the maintainer the only admin who adds global permits (a deploy), so approvers should never
   influence the permit set at all, as proposed?
4. Should `centaur mcp approvals` call out an approval whose permit was removed?

## Decisions (accepted)

1. **Build an allowlist.** No; cookbook, global `context.approved` default, optional `approve`.
2. **Who adds.** Exact definitions: admin or approvers by decision; generalizations: reviewed change only.
3. **Storage.** Repo policy or global policy for generalized allows; per-bot record for exact approvals.
4. **Composition.** Unchanged: any `forbid` wins, no allow outside Cedar.
5. **Generality.** A reaction grants one definition; broader is a reviewed permit.
6. **Listing, revoking, auditing.** Existing `centaur mcp approvals|revoke` and git history; optional stale flag.
7. **Pinning.** No "any version" entry; `pinned` plus a name or source in a reviewed permit.
8. **Tools.** Not here; `allowed_tools` and the `CallTool` design.
9. **`centaur mcp approve`.** Pre-approval of the exact default-branch definition (built).
