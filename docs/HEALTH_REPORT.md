# Repository Health Report

_Last inspected: 2026-11-26 at `5b61006`. See the inspection log for history._

This repository is public. Security findings that are still open are summarized here, and their
exploit detail is kept in a gitignored private addendum (`docs/HEALTH_REPORT.private.md`), which is
held by the maintainer only.

## Summary

The core design is sound. Webhook signatures, chat-side authorization, approval claims, OIDC
verification and the comment-turn gate are all carefully built and well tested.

The main risks fall into three groups:

- **Trust between repositories and bots in AWS.** Tokenless poster calls are still accepted, and
  shared storage is not isolated per repository.
- **Ways a consumer config or a prompt-injected agent can step around the operator's controls.**
  This affects argument building, the MCP "pinned" check, the direct-mode protected paths, and git
  hooks during finish.
- **Reliability.** A message that fails after the webhook is acknowledged is silently lost.
- **Privacy.** A few private identifiers are committed in a public repository (DOCS-001 and
  DOCS-002).

Between `05cbef6` and `5b61006`, CI and gated continuous deployment were added, a `main` ruleset was
created, and the direct-mode trial bot was switched back to pull requests.

Maintainability is otherwise good. It is held back by contracts that are defined twice, once on the
Lambda side and once on the runner side. Many of the "update N places" rules in `AGENTS.md` come
from that.

| Area | Status | Open findings | Last inspected |
| --- | --- | --- | --- |
| Security | needs attention | 2 high, 5 medium, 6 low, 1 info | 2026-11-26 |
| Reliability | needs attention | 1 high, 6 medium, 6 low, 1 info | 2026-11-26 |
| Architecture | minor issues | 7 medium, 1 low | 2026-11-26 |
| Code quality | minor issues | 9 low, 1 info | 2026-11-26 |
| Testing | minor issues | 4 medium, 6 low, 1 info | 2026-11-26 |
| Build & CI | minor issues | 1 medium, 6 low, 1 info | 2026-11-26 |
| Dependencies | healthy | 3 info | 2026-11-26 |
| Docs & DX | needs attention | 1 high, 5 medium, 8 low | 2026-11-26 |

## Triage

Open findings ordered by priority (severity, then confidence, then effort).

| ID | Severity | Title | Effort | Status | Next step |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | high | Poster accepts tokenless calls | S | open | decide |
| SEC-002 | high | Shared session storage not isolated per repository | M | open | fix |
| REL-001 | high | A message that fails after dedup is lost silently | S | open | fix |
| DOCS-001 | high | A real chat identifier and a consumer repository name are committed | S | open | decide |
| DOCS-002 | medium | `TODO.md` names personal consumer repositories | S | open | fix |
| DOCS-005 | medium | `CLAUDE.md` is unfilled template | S | open | fix |
| DOCS-006 | medium | Reactions skill shows the wrong Slack denial emoji | S | open | fix |
| DOCS-007 | medium | README and onboarding still say Slack is unverified | S | open | fix |
| DOCS-004 | medium | `TODO.md` and Beads both claim to be the tracker | M | open | decide |
| SEC-003 | medium | A config value reaches the agent's arguments unescaped | S | open | fix |
| SEC-004 | medium | MCP "pinned" check can be defeated | S | open | fix |
| SEC-005 | medium | Direct-mode protected paths are incomplete | S | open | fix |
| SEC-006 | medium | Post-agent git steps trust agent-writable state | S | open | fix |
| SEC-007 | medium | Inspection role is broader than read-only inspection needs | S | open | fix |
| REL-002 | medium | No timeout on outbound `fetch` | S | open | fix |
| REL-003 | medium | Rotated GitHub token not picked up by warm containers | S | open | fix |
| REL-004 | medium | A `prepare` failure gives the user no notice | S | open | fix |
| REL-006 | medium | `finish` can post the reply and then fail | S | open | fix |
| REL-007 | medium | An aborted access request blocks its subject for 7 days | S | open | fix |
| REL-005 | medium | `if: failure()` likely skips job timeouts | S | open | investigate |
| CI-002 | medium | `main` ruleset has no required status check | S | in-progress | decide |
| ARCH-007 | medium | Lambda `register` parses the full config schema | S | open | fix |
| ARCH-001 | medium | Runner imports Lambda runtime modules for constants | S | open | fix |
| TEST-007 | medium | Fake AWS never validates requests against the poster schema | S | open | fix |
| TEST-003 | medium | `infra.test.ts` mixes mirrors with correspondence tests | S | open | fix |
| ARCH-002 | medium | Poster results are untyped on the runner | M | open | fix |
| ARCH-003 | medium | Structured-output contract is defined in three places | M | open | fix |
| ARCH-004 | medium | Two `ParameterStore` implementations | M | open | decide |
| ARCH-005 | medium | Three hand-rolled GitHub REST clients | M | open | decide |
| ARCH-006 | medium | `ChatMessage` shape is defined three times | S | open | fix |
| TEST-002 | medium | `turn-action.test.ts` is almost all mirror tests | M | open | fix |
| TEST-006 | medium | `src/workflows/cli.ts` has no test | M | open | fix |
| SEC-008 | low | OIDC trust is broad | S | open | decide |
| SEC-010 | low | Some runner errors print IDs to the Actions log | S | open | fix |
| SEC-013 | low | Third-party actions pinned by tag; install scripts enabled | S | open | fix |
| SEC-009 | low | `register` binding is first-come | M | open | decide |
| SEC-011 | low | MCP approval summary is unverified text | M | open | decide |
| SEC-012 | low | Turn directory writes don't check for symlinks | S | open | investigate |
| REL-008 | low | Poster's MCP resume dispatch skips the failure notice | M | open | fix |
| REL-009 | low | A narrow race can leave a suspended turn never resumed | S | open | investigate |
| REL-010 | low | Poster `read` pages a whole Slack thread | M | open | fix |
| REL-011 | low | Non-atomic read-modify-write on two counters | S | open | fix |
| REL-012 | low | Failure-notice slot is used up before the DM is sent | S | open | fix |
| REL-013 | low | No alarms, reserved concurrency or point-in-time recovery | S | open | fix |
| ARCH-008 | low | Lambda bundle exclusion is checked only by hand | S | open | fix |
| CODE-002 | low | Thread branch names have two grammars | S | open | decide |
| CODE-001 | low | `prepare.ts` `Turn` duplicates `TurnState` | S | open | fix |
| CODE-003..009 | low | Ad hoc ID composition, duplicated literals and helpers, type holes | S | open | fix |
| TEST-004, 005 | low | Smaller mirror tests | S | open | fix |
| TEST-008 | low | Scripted chats hide real behavior; no real Slack fixture | M | open | fix |
| TEST-009..011 | low | Docker for every run, local harnesses, order-dependent test | S | open | fix |
| DOCS-003, 008..014 | low | Possible real fixture ID, doc gaps and stale references, `AGENTS.md` duplication | S | open | fix |
| CI-004..010 | low | Local deploy unguarded, rollback zip expiry, no tags, no Dependabot, leftovers, unlinted YAML | S | open | fix |

"Next step" is one of: fix, investigate, decide (needs a human call), monitor.

## Findings

### Security

**Status:** needs attention. Cross-repository and cross-bot trust in AWS has gaps. Several paths let a
config or an injected agent step around operator controls.

**Coverage:**

- **Lambda:** entry points, OIDC and caller check, registry and register, access requests,
  decisions, approvers, admin claims, message handler, MCP approvals, thread starter.
- **Adapters:** webhook verification in the Telegram and Slack adapters.
- **Infra:** `infra/centaur.yml` and `infra/mcp-policy.cedar`.
- **GitHub:** all actions and workflows.
- **Runner:** prepare, AWS, MCP config and policy check, skills, resolve, the push paths and
  transplant.
- **Config:** schema, MCP policy and fingerprint.

**Verified sound:**

- Webhook signatures: Telegram's secret token is compared timing-safe, and Slack's HMAC and
  timestamp are both checked.
- Slash commands authorize themselves.
- `mayDecide` and `authorize` gate both reactions and commands, and decision claims are atomic.
- `isUserId` is checked before any approver path is built.
- The admin claim uses a timing-safe compare and an attempt cap.
- The comment-turn gate and the trusted checkout behave as `AGENTS.md` describes.
- No `${{ }}` interpolation reaches `run:` scripts.

Detail for every open finding in this area is in the private addendum.

#### SEC-001: Poster accepts tokenless calls

- **Severity / confidence / effort:** high / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `src/lambda/caller-check.ts:32-35`. When `RequirePosterToken` is off (the default),
  a call with no token passes with a warning.
- **Impact:** a holder of the shared GitHub role can act as a bot it is not bound to.
- **Recommendation:** set `RequirePosterToken=true` once the tokenless warnings stop.
- **Tracking:** `centaur-8qj`

#### SEC-002: Shared session storage not isolated per repository

- **Severity / confidence / effort:** high / confirmed (code and IAM; not exploited) / M
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `src/workflows/aws.ts:183` (key layout), and the `session-objects` policy on the
  GitHub role in `infra/centaur.yml`.
- **Impact:** one consumer repository can affect another bot's saved state.
- **Recommendation:** scope storage keys and IAM by repository, or broker access through the poster.
  See the addendum.

#### SEC-003: A config value reaches the agent's arguments unescaped

- **Severity / confidence / effort:** medium / likely / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `src/workflows/prepare.ts:588`
- **Impact:** a consumer config could weaken operator-enforced limits.
- **Recommendation:** quote the value the same way the neighboring arguments are quoted, and
  restrict the value in the schema.

#### SEC-004: MCP "pinned" check can be defeated

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** the launcher flag tables in `src/config/mcp-policy.ts`
- **Impact:** the global policy's guarantee that stdio servers run fixed code can be bypassed.
- **Recommendation:** tighten `isPinned`, which fails closed, and add test cases.

#### SEC-005: Direct-mode protected paths are incomplete

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `src/workflows/push-direct.ts:18-25`
- **Impact:** in direct mode, an injected agent could make lasting changes that affect later turns.
  No bot in this repo uses direct mode since `7b7d222`.
- **Recommendation:** extend `isProtectedPath`. See the addendum for the list.

#### SEC-006: Post-agent git steps trust agent-writable state

- **Severity / confidence / effort:** medium / likely / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `src/workflows/push.ts` and `src/workflows/transplant.ts`
- **Impact:** code the agent plants could run in the trusted finish steps.
- **Recommendation:** harden the git invocations now; the full fix is the job split.
- **Tracking:** overlaps `centaur-9af.7`

#### SEC-007: Inspection role is broader than read-only inspection needs

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** the inspection role in `infra/centaur.yml`
- **Recommendation:** deny the secret leaf parameters, and require an explicit principal.

#### SEC-008: OIDC trust is broad

- **Severity / confidence / effort:** low / confirmed / S-M
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** the GitHub role trust in `infra/centaur.yml`, and the owner check in
  `src/lambda/oidc.ts`
- **Recommendation:** check the owner by its numeric ID, and consider limiting `sub` by ref or
  workflow.

#### SEC-009: `register` binding is first-come

- **Severity / confidence / effort:** low / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/register.ts:37-63`
- **Recommendation:** pre-bind the repository in `centaur bot add`, and read the config from the
  default branch.

#### SEC-010: Some runner errors print IDs to the Actions log

- **Severity / confidence / effort:** low / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the S3 `exec` calls in `src/workflows/aws.ts`, and `src/workflows/cli.ts:349`
- **Recommendation:** wrap these errors the way `PosterClient.call` wraps its own.

#### SEC-011: MCP approval summary is unverified text

- **Severity / confidence / effort:** low / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/mcp-approvals.ts:33-37`
- **Recommendation:** label the summary in the DM as unverified, or derive it on the poster.

#### SEC-012: Turn directory writes don't check for symlinks

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the `TURN_DIR` writes in `src/workflows/prepare.ts`
- **Recommendation:** recreate the directory fresh before writing.

#### SEC-013: Third-party actions pinned by tag; install scripts enabled

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `.github/actions/turn/action.yml:54, 109`
  - `.github/actions/setup-runtime/action.yml`
  - `.yarnrc.yml`
  - the job-level `GITHUB_MCP_TOKEN` in `centaur-turn.yml`
- **Impact:** a moved upstream tag runs in every consumer's turn, with their secrets.
- **Recommendation:**
  - SHA-pin the actions inside `.github/actions` (start with `claude-code-action`);
  - set `enableScripts: false`;
  - move `GITHUB_MCP_TOKEN` to step level.
- **Notes:** this absorbs the Build & CI finding on action pinning.

#### SEC-014: Access-request rate limit is shared by all subjects

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/access-request-store.ts:5-6, 75-83`. The limit is 10 per hour per bot.
- **Impact:** a stranger can use up the limit, so legitimate requests get "limited".
- **Recommendation:** add a cap per chat or per user.

### Reliability

**Status:** needs attention. Several failure paths end with 👀 on the message and no reply, and
nothing alerts the operator.

**Coverage:**

- **Lambda:** most of it.
- **Runner:** cli, finish, AWS, reactions, MCP approval, PR target and most of prepare.
- **GitHub:** the turn and notify-failure actions.
- **Infra:** `infra/centaur.yml`.
- **Dependencies:** the Chat SDK's dedup and history paths, and the DynamoDB state fork.

**Verified sound:**

- Conditional writes for locks and dedup.
- Slack retries are deduplicated.
- Applier claims are released on error.
- Best-effort PR and reaction steps.

#### REL-001: A message that fails after dedup is lost silently

- **Severity / confidence / effort:** high / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:**
  - The Chat SDK writes the dedup key before the handler runs and only logs handler errors.
  - `src/lambda/receiver.ts:74-82` always returns the adapter's 200.
  - `src/lambda/message-handler.ts:134-139` adds 👀 and then dispatches.
  - `src/lambda/github.ts:18-29` makes a single `fetch` with no retry.
- **Impact:**
  - A GitHub 5xx, an SSM throttle or a DynamoDB error loses the message.
  - A platform retry can't recover it: the platform got a 200, and the retry hits the dedup key.
  - Only dispatch errors reach the admin.
- **Recommendation:** retry the dispatch with backoff. On final failure, reply "couldn't start,
  please resend" and remove 👀.

#### REL-002: No timeout on outbound `fetch`

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/github.ts:18` and `src/lambda/telegram.ts:25`, against `Timeout: 30` in
  `infra/centaur.yml`.
- **Impact:** a hung call uses up the Lambda's 30s, and `withFailureNotice` never runs.
- **Recommendation:** pass `signal: AbortSignal.timeout(10_000)`.

#### REL-003: Rotated GitHub token not picked up by warm containers

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/handler.ts:59-61, 71, 102` memoize the dispatcher for the container's
  life.
- **Recommendation:** read the token through the cached parameter store, or re-read it on a 401.

#### REL-004: A `prepare` failure gives the user no notice

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/finish.ts:506-510` returns early when there is no turn state.
  - The state is written late in `prepare` (`prepare.ts:706`).
- **Recommendation:** fall back to the dispatch `client_payload` for the bot and thread.

#### REL-005: `if: failure()` likely skips job timeouts

- **Severity / confidence / effort:** medium / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `.github/workflows/centaur-turn.yml:20, 38`. The same pattern appears in the other
  turn workflows and in the templates in `docs/workflows.md`.
- **Recommendation:** use `if: failure() || cancelled()`. Confirm GitHub's behavior with a job that
  sleeps past its timeout.

#### REL-006: `finish` can post the reply and then fail

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/workflows/finish.ts:451, 468, 471`. The reply is posted first, and the marker
  write and session save that follow are unguarded.
- **Impact:** the user gets the reply, then a "turn failed" notice, and the next turn answers the
  same messages again.
- **Recommendation:** write the marker before delivering, and make `saveSession` best effort.

#### REL-007: An aborted access request blocks its subject for 7 days

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/lambda/access-request-store.ts:86-87, 98-99`
  - `src/lambda/access-requests.ts:89-98`: nothing releases the slot when a step after `claimSlot`
    throws.
- **Recommendation:** when anything after `claimSlot` throws, call `releaseSubject` and rethrow.

#### REL-008: Poster's MCP resume dispatch skips the failure notice

- **Severity / confidence / effort:** low / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/lambda/handler.ts:90` uses the raw dispatcher, which goes against the `createBotChat` rule
    in `AGENTS.md`.
  - `src/lambda/mcp-approvals.ts:185-187` dispatches through it.

#### REL-009: A narrow race can leave a suspended turn never resumed

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/lambda/access-decisions.ts:105-108, 150-152`
  - `src/lambda/mcp-approvals.ts:156-173`
- **Recommendation:** re-read the request after `claimDecision`.

#### REL-010: Poster `read` pages a whole Slack thread

- **Severity / confidence / effort:** low / likely / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/poster.ts:271-300`
- **Impact:** a long thread can exceed the 30s timeout or the 6 MB response cap. The transcript
  budget is only applied later, on the runner.
- **Recommendation:** cap the read on the Lambda side, or stop at the marker.

#### REL-011: Non-atomic read-modify-write on two counters

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - the approver cap: `src/lambda/access-decisions.ts:161-167` and
    `src/lambda/approver-commands.ts:191-192, 226`;
  - the claim-failure counter: `src/lambda/admin-claims.ts:70-78`.
- **Recommendation:** use an atomic increment for the claim counter. The approver cap is acceptable
  as is.

#### REL-012: Failure-notice slot is used up before the DM is sent

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/dispatch-failure-notice.ts:69-96`
- **Impact:** a DM that fails silences dispatch-failure notices for the whole interval.
- **Recommendation:** delete the key when `notify` throws.

#### REL-013: No alarms, reserved concurrency or point-in-time recovery

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** nothing in `infra/centaur.yml` matches Alarm, MetricFilter, ReservedConcurrent or
  PointInTime.
- **Recommendation:** add an alarm on Lambda `Errors` and `Throttles`, a metric filter on "Message
  processing error", and point-in-time recovery on `StateTable`.

#### REL-014: Every poster operation initializes a new `Chat`

- **Severity / confidence / effort:** info / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/poster.ts:175-179`
- **Impact:** an extra platform API round trip on every poster call.

### Architecture

**Status:** minor issues. The Lambda bundle boundary holds: nothing in `src/lambda` imports the
runner or the MCP code. Contracts between the Lambda and the runner are defined twice.

**Coverage:**

- **Runner:** most of `src/workflows`.
- **Lambda:** the poster, chat context, parameters, access, register and GitHub modules.
- **Config:** `src/config`.
- **CLI and MCP:** parts of `src/cli` and `src/mcp`.
- **Scans:** import graph, casts, duplicated literals.

Most `AGENTS.md` "update N places" rules can be traced to ARCH-002, 003, 004, 006 and 007.

#### ARCH-001: Runner imports Lambda runtime modules for constants

- **Severity / confidence / effort:** medium / confirmed / S-M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/reactions.ts:1`
  - `src/workflows/prompt.ts:2`, `src/workflows/finish.ts:3`, `src/workflows/mcp-approval.ts:4`
  - `src/workflows/aws.ts:8-23`
  - `src/mcp/poster-chat-client.ts:1`
  
  These pull in `chat` and `@aws-sdk/client-ssm` at runner startup.
- **Recommendation:** add a dependency-free poster contract module that both sides import.

#### ARCH-002: Poster results are untyped on the runner

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/aws.ts:47, 94, 133` (`call<T = unknown>`, then `z.custom` for the result);
  - the `resolve-pull-request` result is redeclared in `prepare.ts:458`, `pr-target.ts:113` and
    `resolve.ts:135`;
  - `OPTIONAL_TOKEN_OPERATIONS` is a plain `ReadonlySet<string>`.
- **Recommendation:** add a result schema per operation, keyed by operation name, and make `call`
  generic over the operation.

#### ARCH-003: Structured-output contract is defined in three places

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/prompt.ts:205-277` (hand-written JSON Schema)
  - `src/workflows/finish.ts:23-42` (zod schema)
  - `src/workflows/finish.ts:49-59` (field-by-field rename)
- **Recommendation:** use one zod object and emit the JSON Schema with `z.toJSONSchema`.

#### ARCH-004: Two `ParameterStore` implementations

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/lambda/parameters.ts:13-20` and `src/cli/parameter-store.ts:10-17`; their `get` is
    identical.
  - The CLI lists destinations with one call per name (N+1), `src/cli/destinations.ts:11-14`.
- **Recommendation:** one shared SSM adapter; the Lambda takes a `Pick<>` of it.

#### ARCH-005: Three hand-rolled GitHub REST clients

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/workflows/resolve.ts:177-222`, `src/lambda/github.ts:17-29`, and the pull-request
  schemas in `resolve.ts`, `pr-target.ts` and `pull-request-comments.ts`.
- **Recommendation:** use `@octokit/request` on the runner, or at least share one requester and one
  set of schemas.

#### ARCH-006: `ChatMessage` shape is defined three times

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - the type: `src/workflows/transcript.ts:4-12`;
  - the schema: `src/lambda/chat-context.ts:55-64`;
  - the mappers: `src/lambda/poster.ts:294-302` and `chat-context.ts:133-142`.

#### ARCH-007: Lambda `register` parses the full config schema

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/register.ts:38` parses the full schema but uses only `bot` and
  `platforms`.
- **Impact:** forces the "deploy before pushing a new config key" rules in `AGENTS.md`.
- **Recommendation:** parse a narrow passthrough schema in the Lambda, and leave full validation to
  the runner.

#### ARCH-008: Lambda bundle exclusion is checked only by hand

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the `AGENTS.md` rule about running `rg` on the bundle. Neither `yarn verify` nor CI
  checks it.
- **Recommendation:** an esbuild metafile check inside `verify`.

### Code quality

**Status:** minor issues. The problems are repetition and ad hoc string formats.

#### CODE-001: `prepare.ts` `Turn` duplicates `TurnState`

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/prepare.ts:164-182` and `:97-117` (the two types);
  - `:676-691` (ten conditional spreads);
  - `prTargetFlags(...)` called in three builders.
- **Recommendation:** derive `Turn` from `TurnState`, and compute the targets once.

#### CODE-002: Thread branch names have two grammars

- **Severity / confidence / effort:** low / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - built in `src/workflows/prepare.ts:737-739` and `finish.ts:269`;
  - matched by `isThreadBranch` in `src/workflows/resolve.ts:8-14`, which accepts only a hex key;
  - `resolve.ts:120` uses `startsWith(BRANCH_PREFIX)`.
- **Impact:** PRs from scheduled prompts and new threads can never be update targets.
- **Recommendation:** one `threadBranch()` builder. Whether those PRs should be targets is a
  decision for the maintainer.

#### CODE-003: Channel and thread IDs are composed by hand

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `channelId.slice(bot.platform.length + 1)` in four files;
  - `` `${bot.platform}:${chatId}` `` in two;
  - `threadId.split(":")[1]` in `src/mcp/poster-chat-client.ts:19`.
- **Recommendation:** add `channelIdOf` and `chatIdOf` next to `buildThreadId`.

#### CODE-004: MCP approval key re-encoded outside `mcpApprovalKey`

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - encoded again in `src/lambda/access-requests.ts:208`;
  - decoded in two different ways, in `src/workflows/mcp-approval.ts:74` and `connection-paths.ts`.

#### CODE-005: Dispatch payload schema defined on each side

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/message-handler.ts:26-31` and `src/workflows/prepare.ts:87-91`.

#### CODE-006: Config schema repeats nested defaults

- **Severity / confidence / effort:** low / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/config/schema.ts:182-191, 209-222, 244-255`
- **Recommendation:** use `.prefault({})` so the inner defaults apply.

#### CODE-007: `src/workflows/cli.ts` repeats URL, env and token plumbing

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - the server URL is built four times;
  - two inline OIDC fetchers sit next to the existing `oidcFetcher`;
  - positive-integer env vars are parsed three different ways;
  - `push-existing` uses an unchecked `Number(...)` at `:224`.

#### CODE-008: Duplicated literals and small helpers

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - the string `"Centaur agent changes"` appears four times;
  - there are two `exists` helpers;
  - `ExecutionMode` is defined twice;
  - `PushExistingFailure` is hand-copied from `TransplantFailure`;
  - the `::warning::` pattern appears five times in `finish.ts`.

#### CODE-009: Type holes

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/turn-state.ts:57` (`JSON.parse(...) as TurnState`)
  - `src/workflows/mcp-approval.ts:76`
  - `src/workflows/pull-request-comments.ts:242, 287`
  - `src/workflows/aws.ts:58`
  
  No `any` and no non-null assertions were found.
- **Recommendation:** give `TurnState` a zod schema.

#### CODE-010: Exports with no consumer outside their own file

- **Severity / confidence / effort:** info / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** a rough scan found about 115 of 603 exports used only in their own file, for example
  `DISPATCH_EVENT_TYPE`, `webhookUrl` and `REQUEST_TTL_MS`.
- **Recommendation:** run `knip` once to confirm, then un-export what isn't used.

### Testing

**Status:** minor issues. Critical paths are well covered: OIDC with real JWTs, the comment gate,
MCP policy fail-closed paths, access decisions, and the push paths on real git. DynamoDB tables are
per test. But several tests mirror YAML, and the runner's glue file is untested.

**Coverage:**

- every test that reads repository files;
- a map from each source file to the tests that import it;
- timer and global restoration;
- network and Docker use;
- the main fakes.

The bodies of the largest suites were not read.

#### TEST-001: No CI ran the tests

- **Status:** fixed in `942d0d7` (see CI-001).

#### TEST-002: `turn-action.test.ts` is almost all mirror tests

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `test/turn-action.test.ts:9-85` asserts step IDs, `if:` strings and env-key lists
  as literals.
- **Recommendation:** replace with the correspondence test in TEST-006, then delete these. Also
  update the `AGENTS.md` line that names this file.

#### TEST-003: `infra.test.ts` mixes mirrors with correspondence tests

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - Mirrors: `test/infra.test.ts:41-47, 65-75, 83-119, 147-156`.
  - Correspondence tests whose code side is typed by hand: `:49-63, 77-81, 121-125, 173-194`.
  - Real correspondence tests: `:131-145, 160-188`.
  - The `covers` lambda is duplicated three times.
- **Recommendation:** delete the mirrors, and take the code side of the correspondence tests from
  code.

#### TEST-004: `self-consumer.test.ts` mirrors the test bots' configs

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the literal `toEqual` checks in `test/self-consumer.test.ts`.
- **Recommendation:** keep the parse, discovery and file-exists checks, plus one cross-bot invariant.

#### TEST-005: Smaller mirror tests

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `test/slack-manifest.test.ts:9-13`
  - `test/root-input-action.test.ts:11-19`
  - `test/workflow-schedule-group.test.ts:48-56, 64-65`

#### TEST-006: `src/workflows/cli.ts` has no test

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:** no test imports it. It holds the validation and output mapping for every composite
  action.
- **Recommendation:** have each command export the env names it reads, and assert that each
  `action.yml` step provides them.

#### TEST-007: Fake AWS never validates requests against the poster schema

- **Severity / confidence / effort:** medium / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `test/helpers/workflow-fixtures.ts:58-62` casts `as PosterRequest`.
- **Recommendation:** run `posterRequestSchema.parse` in `createFakeAws`.

#### TEST-008: Scripted chats hide real behavior; no real Slack fixture

- **Severity / confidence / effort:** low / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `test/helpers/poster-fixtures.ts:111-128`: a single `allMessages` generator, and one shared
    thread object for every ID.
  - `realTelegramChat` is used by only one test, and there is no Slack equivalent.

#### TEST-009: Every test run needs Docker

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `test/global-setup.ts:40-57`
- **Recommendation:** move the DynamoDB-backed tests into a separate Vitest project.

#### TEST-010: Local harnesses in test files

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `setup`-style harnesses in `message-handler`, `telegram-start`,
  `chat-dynamodb-state`, `channel-history`, `attachments`, `cli-access` and `push-direct` tests.
  Also, `test/action-fixtures.ts` sits outside `test/helpers/`.

#### TEST-011: `admin-handlers.test.ts` depends on registration order

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the test picks handlers by index, `onSlashCommand.mock.calls[0..2]`.

#### TEST-012: Test hygiene

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `mkdtemp` directories in the fixtures are never removed;
  - `test/helpers/git-fixtures.ts` doesn't isolate global git config.

### Build & CI

**Status:** minor issues. CI and gated continuous deployment exist as of `942d0d7`, and `main` has
a ruleset.

**Coverage:**

- every workflow and action;
- the deploy script and docs;
- the manifests and lockfile;
- the GitHub repository settings.

The CD deploy role and `scripts/setup-cd.sh`, both added in `942d0d7`, were not audited.

#### CI-001: No CI ran `verify` or `lint:cfn`

- **Severity / confidence / effort:** high / confirmed / S
- **Status:** fixed (first seen 2026-11-26 at `05cbef6`; fixed in `942d0d7`, which added
  `.github/workflows/ci.yml` and `deploy.yml`)

#### CI-002: `main` ruleset has no required status check

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** in-progress (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:**
  - The ruleset on `main` (created 2026-11-26) blocks deletion and force-push and requires a PR with
    0 approvals.
  - It does not require the CI check, and the admin role can always bypass it.
  - The repository setting `can_approve_pull_request_reviews` is `true`.
- **Impact:** a PR can merge with failing CI. Consumers run `@main`. Deploys are gated by CI,
  but consumer actions are not.
- **Recommendation:** require the `CI / verify` status check. Turn off "Allow GitHub Actions to
  approve pull requests" unless something needs it.

#### CI-003: Direct-mode test bot pushed to this repo's `main`

- **Status:** fixed (first seen 2026-11-26; fixed in `7b7d222`, which removed direct mode, and by
  the ruleset)
- **Notes:** the underlying path gap is SEC-005.

#### CI-004: Local `yarn deploy-prod` is unguarded

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `scripts/deploy.sh` has no clean-tree check, no `verify` and no commit tag.
- **Notes:** the CD path in `deploy.yml` verifies first and requires a merged commit, so this only
  affects local deploys.
- **Recommendation:**
  - refuse to run on a dirty tree;
  - tag the stack with `GitCommit`;
  - document rollback.

#### CI-005: The zip that a CloudFormation rollback needs can expire

- **Severity / confidence / effort:** low / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the `expire-lambda-zips` lifecycle rule in `infra/centaur.yml` (30 days by default).
- **Impact:** a deploy that fails more than 30 days after the last code change may end in
  `UPDATE_ROLLBACK_FAILED`.

#### CI-006: No tags or releases

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `docs/workflows.md:125` advises pinning to a tag, but none exist.
- **Recommendation:** cut a moving `v0` tag after each verified deploy, or reword the doc to say
  "pin to a SHA".

#### CI-007: `setup-runtime` installs every devDependency without a cache

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** monitor (first seen 2026-11-26)
- **Evidence:** `.github/actions/setup-runtime/action.yml:13-22`. It takes about 8s per job today.

#### CI-008: No automated dependency updates

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** there is no `dependabot.yml`. The AWS SDK, cedar-wasm, vitest, biome and jose are a
  few patch releases behind.
- **Recommendation:** add Dependabot for `npm` and `github-actions`.

#### CI-009: Experiment leftovers

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `.github/workflows/agent-runtime.yml` names a branch that no longer exists;
  - stale remote `centaur/centaur-*` branches.
  - (`scratch/` was removed in `7b7d222`.)

#### CI-010: Shell and workflow YAML are unlinted

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `biome.json` covers code and JSON only.
- **Recommendation:** add `actionlint` and `shellcheck` to CI.

### Dependencies

**Status:** healthy. Pins are close to latest. There is one copy each of `zod` and the AWS SDK.

#### DEP-001: Two `jose` copies

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `yarn.lock` has 6.2.13 (direct) and 6.2.18 (via the MCP SDK).
- **Recommendation:** bump the direct dependency to 6.2.18.

#### DEP-002: Lambda bundle is 5.4 MB and unminified

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** monitor (first seen 2026-11-26)
- **Evidence:** `bundle:lambda` in `package.json`. The bulk is the AWS SDK, the Slack SDK and zod;
  the MCP SDK and cedar-wasm are absent, as required.

#### DEP-003: The state-adapter fork declares open-ended peer ranges

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `@blevinstein/chat-state-dynamodb` declares `chat: ">=4.0.0"`.
- **Recommendation:** tighten the range to `^4`.

### Docs & DX

**Status:** needs attention. The reference docs mostly match the code, and every relative link and
anchor resolves (about 420 were checked). But some private identifiers are committed in this public
repository, and two task trackers contradict each other.

**Coverage:**

- `docs/config.md` checked against `src/config/schema.ts`;
- `docs/cli.md` checked against every commander definition;
- `docs/poster.md` checked against the poster schemas;
- `docs/workflows.md` checked against the inputs and outputs in `action.yml`;
- all five `SKILL.md` files checked against the code;
- every path and symbol named in `AGENTS.md`, all of which exist;
- a privacy pattern scan across the repository;
- all internal links.

**Not covered:**

- a line-by-line read of the large design docs;
- `src/workflows/instructions/*.md`;
- `docs/workflows.md` after line 460;
- `docs/deploy.md` against the stack parameters.

The specific identifiers for DOCS-001 to DOCS-003 are in the private addendum.

#### DOCS-001: A real chat identifier and a consumer repository name are committed

- **Severity / confidence / effort:** high / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** two entries in `DONE.md`
- **Impact:** breaks the `AGENTS.md` rule that keeps chat IDs and consumer repository names out of
  the repo. The identifier is also in git history.
- **Recommendation:** replace both with placeholders. Whether to scrub the history is the
  maintainer's call.

#### DOCS-002: `TODO.md` names personal consumer repositories and their purpose

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** three "Setup .centaur config" items in `TODO.md`
- **Recommendation:** reword them generically, or move them to a private tracker.

#### DOCS-003: A Slack fixture may use a real channel ID

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `test/helpers/slack-fixtures.ts:23`. The other fixtures use obvious placeholders.
- **Recommendation:** switch to an obvious placeholder.

#### DOCS-004: `TODO.md` and Beads both claim to be the tracker, and have drifted apart

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `AGENTS.md:13` says `TODO.md` holds all open work, while `AGENTS.md:237`, `:294` and
    `.cursor/rules/beads.mdc` say to use `bd` for everything.
  - The `centaur-9af` epic is missing from `TODO.md`.
  - `centaur-8qj` and `centaur-ck1` duplicate items in `TODO.md`.
  - `centaur-gum` is closed in Beads, but the matching `TODO.md` item is still open.
  - `.beads/` is gitignored, so runner agents can't see Beads at all.
- **Recommendation:** decide which tracker is authoritative, or split them by purpose, then
  reconcile the items above.

#### DOCS-005: `CLAUDE.md` is unfilled template and doesn't point to `AGENTS.md`

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `CLAUDE.md:61-77` still holds placeholders such as "_Add your build and test commands
  here_".
- **Impact:** Claude Code loads `CLAUDE.md`, so it misses every rule in `AGENTS.md`.
- **Recommendation:** replace the placeholders with `@AGENTS.md`, or symlink `CLAUDE.md` to
  `AGENTS.md`.

#### DOCS-006: The reactions skill shows the wrong emoji for a Slack denial

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:**
  - the code uses `no_entry_sign`, which is 🚫 (`src/lambda/approval-reactions.ts:24`);
  - `skills/centaur-reactions/SKILL.md:3, 20` says ⛔.
- **Recommendation:** change ⛔ to 🚫 in both places.

#### DOCS-007: README and onboarding still say Slack is unverified

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `README.md:117` and `docs/onboarding.md:5, 360-362` say Slack is untested end to end.
  - `TODO.md` §12 records a live Slack onboarding and a measured acknowledgement time.
- **Recommendation:** update the Limits section and the "Still unverified" list.

#### DOCS-008: `docs/workflows.md` omits three workflow CLI commands

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `docs/workflows.md:394` doesn't list `plan-pr`, `push-existing` or `push-direct`, which are
    defined in `src/workflows/cli.ts:208, 223, 247`.
  - Line 388 has the typo "theactions".

#### DOCS-009: `config check --root` is not documented

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/cli/commands/config.ts:34` defines the flag; `docs/cli.md:341` doesn't mention
  it.

#### DOCS-010: `docs/config.md` miscounts the per-platform keys

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `docs/config.md:94` says "two optional keys", but the schema has three
  (`src/config/schema.ts:97-104`).

#### DOCS-011: `AGENTS.md` repeats rules and is hard to navigate

- **Severity / confidence / effort:** low / confirmed / M
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - the venv setup appears three times (`:35`, `:52`, `:183`);
  - the deploy-ordering rule appears twice (`:126`, `:217`);
  - there are two Beads blocks;
  - about 85 rules sit in one flat list.
- **Recommendation:** remove the duplicates and group the rules by area.

#### DOCS-012: The SSM layout table is incomplete

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** the table in `docs/plan.md#ssm-parameter-layout` lacks three keys: the approvers,
  the MCP approvals, and `/centaur/state-table`.

#### DOCS-013: Finished design docs name files that don't exist

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `docs/platforms-and-destinations.md:506-510, 582-588` (files such as `chat-aliases.ts` and
    `commands/destination.ts`);
  - `docs/chat-context.md:261`, which names `chat-server-main.js`.
- **Recommendation:** fix `chat-context.md:261`, and mark `platforms-and-destinations.md` as
  historical.

#### DOCS-014: Small gaps in `docs/poster.md`

- **Severity / confidence / effort:** low / likely / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `docs/poster.md:10` says every operation except `register` needs a bound bot, but
    `get-mcp-policy` and `resolve-pull-request` take no bot.
  - The `mcp-approvals` row doesn't mention that `suspend` needs `threadId`.

## Not yet inspected

**Not covered by any area:**

- the CD deploy role in `infra/centaur.yml` and `scripts/setup-cd.sh`, both added in `942d0d7`;
- `src/workflows/finish.ts` validation of agent output (`start` targets, PR targets) and
  `pr-target.ts`/`checkCandidate`, both in depth;
- the tool surface of `src/mcp/chat-server.ts`;
- `src/cli/**` beyond the parameter store and destinations;
- the Chat SDK adapters' own outbound timeouts and retries;
- performance;
- the data model (the SSM layout and DynamoDB keys, which were inspected only as needed for
  security).

**Open questions that need runtime access or the maintainer:**

- Does claude-code-action split `claude_args` shell-style? This confirms SEC-003.
- In headless runs, does Claude Code load the workspace `.mcp.json` and `.claude/settings.json` when
  `--setting-sources` is unset? Can its Write tool write under `.git/`? These decide SEC-005 and
  SEC-006.
- Does GitHub evaluate `failure()` as true when a job hits `timeout-minutes`? (REL-005)
- How often does "Message processing error" appear in CloudWatch, and how many Slack acks take
  longer than 3s? (REL-001)
- Do any external consumers run `@main` today? This sets the urgency of CI-002 and SEC-013.
- Should PRs from scheduled prompts and new threads be eligible as update targets? (CODE-002)

## Inspection log

- 2026-11-26 `05cbef6` to `5b61006`: first run.
  - Areas inspected: security, reliability, architecture and code quality, testing, build & CI,
    dependencies, and docs & DX.
  - Results: 85 findings, of which 3 were already fixed by commits that landed during the audit
    (CI-001, CI-003, TEST-001).
  - Verification: every high finding was re-checked at `5b61006`, as were DOCS-002, DOCS-005 and
    DOCS-006.
  - Not covered: the CD changes from `942d0d7`.
