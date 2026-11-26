# Repository Health Report

_Last inspected: 2026-11-26 at `33f395c`. See the inspection log for history._

This repository is public. Security findings that are still open are summarized here, and their
exploit detail is kept in a gitignored private addendum (`docs/HEALTH_REPORT.private.md`), which is
held by the maintainer only.

## Summary

The core design is sound. Webhook signatures, chat-side authorization, approval claims, OIDC
verification and the comment-turn gate are all carefully built and well tested. Since the first
run, most of the first run's medium findings were fixed or closed, and the per-call MCP gate and
continuous deployment were reviewed.

The main risks now fall into three groups:

- **The agent and the trusted steps share one runner.** An agent with `Bash` can write the files
  and environment that the later trusted steps (the MCP audit, the push and finish steps) and the
  tool gate read: `GITHUB_ENV`, the turn state directory, the built CLI (SEC-006, SEC-016 (accepted),
  SEC-019). The full fix is the job split already tracked as `centaur-9af.7`.
- **Operator controls that a consumer config can still step around.** The MCP "pinned" check and
  the policy ignore a server's `env` (SEC-017). Shared session storage is still not isolated per
  repository (SEC-002).
- **Continuous deployment.** The deploy job installs dependencies, with install scripts on, while
  the OIDC token for the deploy role is available (SEC-018). Merging to `main` is still equivalent
  to administering the stack (CI-002, documented in `docs/deploy.md`).

Closed since the first run: the tokenless poster calls (live setting `RequirePosterToken=true`),
the argument-building and direct-mode path findings, the lost-message and timeout findings, three
of the architecture findings and three of the testing findings, and four documentation findings.
Privacy findings DOCS-001 to DOCS-003 remain fixed; the identifiers remain in git history.

Maintainability is otherwise good. It is held back by contracts that are defined twice, once on the
Lambda side and once on the runner side. Many of the "update N places" rules in `AGENTS.md` come
from that.

| Area | Status | Open findings | Last inspected |
| --- | --- | --- | --- |
| Security | needs attention | 1 high, 5 medium, 7 low, 1 info | 2026-11-26 |
| Reliability | minor issues | 1 medium, 11 low, 1 info | 2026-11-26 |
| Architecture | minor issues | 5 medium, 1 low | 2026-11-26 |
| Code quality | minor issues | 9 low, 1 info | 2026-11-26 |
| Testing | minor issues | 1 medium, 6 low, 1 info | 2026-11-26 |
| Build & CI | minor issues | 1 medium, 7 low, 1 info | 2026-11-26 |
| Dependencies | healthy | 3 info | 2026-11-26 |
| Docs & DX | minor issues | 1 medium, 6 low | 2026-11-26 |

## Triage

Open findings ordered by priority (severity, then confidence, then effort). Lower-severity
findings are grouped at the end. Fixed and wontfix findings are listed in each area below, not here.

| ID | Severity | Title | Effort | Status | Next step |
| --- | --- | --- | --- | --- | --- |
| SEC-002 | high | Shared session storage not isolated per repository | M | open (documented) | fix |
| SEC-017 | medium | MCP `pinned` check and policy ignore a server's `env` | S | open | fix |
| SEC-018 | medium | Deploy job runs install scripts while the deploy role's OIDC token is available | S | open | fix |
| CI-002 | medium | `main` ruleset has no required status check | S | in-progress | decide |
| REL-006 | medium | `finish` writes the processed marker after posting the reply, unguarded | S | partly done | fix |
| SEC-007 | medium | Inspection role is broader than read-only inspection needs | S | open (documented) | decide |
| SEC-006 | medium | Post-agent git steps trust agent-writable state | S | open | fix |
| SEC-019 | medium | Tool-gate policy, hook settings and entry script are agent-writable (suspicion) | S | open | investigate |
| ARCH-007 | medium | Lambda `register` parses the full config schema | S | open | fix |
| DOCS-004 | medium | `TODO.md` and Beads both claim to be the tracker | M | open | decide |
| TEST-002 | medium | `turn-action.test.ts` is almost all mirror tests | M | open | fix |
| ARCH-002 | medium | Poster results are untyped on the runner | M | open | fix |
| ARCH-003 | medium | Structured-output contract is defined in three places | M | open | fix |
| ARCH-004 | medium | Two `ParameterStore` implementations | M | open | decide |
| ARCH-005 | medium | Three hand-rolled GitHub REST clients | M | open | decide |
| SEC-008, 009, 011, 012, 015, 020 | low | OIDC trust breadth, first-come `register`, unverified approval summary, symlink writes, install scripts and MCP token scope, name-prefix IAM scoping | S-M | open | fix or decide |
| SEC-010 | low | The top-level runner error handler still prints any error message | S | partly done | fix |
| REL-008..013, REL-015..019 | low | Resume dispatch skips the failure notice, small races, unbounded reads and loops, no alarms | S-M | open | fix |
| ARCH-008, CODE-001..009 | low | Bundle check by hand, duplicated shapes and literals, type holes | S | open | fix |
| TEST-004, 005, 008..011 | low | Smaller mirror tests, scripted chats, Docker for every run, local harnesses | S-M | open | fix |
| DOCS-008, 009, 011..014 | low | Doc gaps and stale references, `AGENTS.md` duplication | S | open | fix |
| CI-004..006, 008..011 | low | Local deploy unguarded, rollback zip expiry, no tags, no Dependabot, leftovers, unlinted YAML, redeploy of older commits | S | open | fix |

"Next step" is one of: fix, investigate, decide (needs a human call), monitor.

## Findings

### Security

**Status:** needs attention. Shared session storage is not isolated per repository, and an agent
that is allowed `Bash` can reach the files and environment that the trusted steps and the MCP tool
gate depend on.

**Coverage:**

- **Lambda:** entry points, OIDC and caller check, registry and register, access requests,
  decisions, approvers, admin claims, message handler, MCP approvals, thread starter.
- **Adapters:** webhook verification in the Telegram and Slack adapters.
- **Infra:** `infra/centaur.yml` (including `DeployRole` and `DeployPolicy`) and
  `infra/mcp-policy.cedar`.
- **GitHub:** all actions and workflows, including `deploy.yml` and `ci.yml`.
- **Runner:** prepare, AWS, MCP config and policy check, skills, resolve, the push paths and
  transplant; the per-call tool gate and audit (`tool-gate.ts`, `tool-audit.ts`); repository
  instructions.
- **Config:** schema, MCP policy and fingerprint, `checkToolCall`.
- **Added 2026-11-26 (code merged since `5b61006`):** the Slack search token capture and
  `search-chat` (`search-token.ts`, `search-chat.ts`, `slack-search.ts`), access requests for chat
  and user together, `ownsMessage` and `bot_messages`, self-identity, the redelivery wrapper, and
  the CLI-locate step in the composite actions.

**Verified sound:**

- Webhook signatures: Telegram's secret token is compared timing-safe, and Slack's HMAC and
  timestamp are both checked.
- Slash commands authorize themselves.
- `mayDecide` and `authorize` gate both reactions and commands, and decision claims are atomic.
- `isUserId` is checked before any approver path is built.
- The admin claim uses a timing-safe compare and an attempt cap.
- The comment-turn gate and the trusted checkout behave as `AGENTS.md` describes.
- No `${{ }}` interpolation of attacker-controlled values reaches `run:` scripts. The only
  interpolation is `github.action_path` in the CLI-locate step, which the workflow author chooses.
- The per-call MCP gate is built to fail closed: a `PreToolUse` hook with `onFailure: block`, a
  shell wrapper that maps every failure to exit 2, `--setting-sources user` so the workspace cannot
  switch hooks off, and an audit step that re-checks the execution file
  (`src/workflows/tool-gate.ts`, `tool-audit.ts`, `prepare.ts:92, 606-609`).
- `search-chat` only returns messages from the thread's own approved chat and only from approved
  senders (`src/lambda/chat-context.ts:243-253`, `search-chat.ts:104-111`); the stored Slack
  `action_token` expires after 10 minutes.
- Self-identity strings are reduced to a short single line without markup (`src/self-identity.ts`).
- The deploy role cannot edit its own trust, policies or boundary, and the `production` environment
  accepts only `main` (`infra/centaur.yml`, `DeployPolicy` denies; `scripts/setup-cd.sh`).

Detail for every open finding in this area is in the private addendum.

#### SEC-001: Poster accepts tokenless calls

- **Severity / confidence / effort:** high / confirmed / S
- **Status:** fixed 2026-11-26 in the maintainer's deployment (first seen 2026-11-26, last verified
  2026-11-26): `RequirePosterToken=true` is live, after 3 days with no tokenless calls.
- **Evidence:** `src/lambda/caller-check.ts:26-30` rejects a call with no token when `required` is
  set; `infra/centaur.yml:44, 492` wires the parameter to `REQUIRE_POSTER_TOKEN`.
- **Impact:** the template default is still `false`, so an installation that has not set the
  parameter still accepts tokenless calls. That is documented (`docs/deploy.md:28`,
  `docs/poster.md:305-317`).
- **Recommendation:** none for this deployment. Consider defaulting the template to `true` before
  anyone else installs it.
- **Tracking:** `centaur-8qj`

#### SEC-002: Shared session storage not isolated per repository

- **Severity / confidence / effort:** high / confirmed (code and IAM; not exploited) / M
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26): the risk is now documented in
  `docs/poster.md` ("Session and attachment storage", `ed5bb4d`) but not fixed.
- **Evidence:** `src/workflows/aws.ts:183` (key layout), and the `session-objects` policy on the
  GitHub role in `infra/centaur.yml`.
- **Impact:** one consumer repository can affect another bot's saved state.
- **Recommendation:** scope storage keys and IAM by repository, or broker access through the poster.
  See the addendum.

#### SEC-003: A config value reaches the agent's arguments unescaped

- **Severity / confidence / effort:** medium / likely / S
- **Status:** fixed (first seen 2026-11-26; fixed in `8172a42`, verified 2026-11-26)
- **Evidence:** `src/workflows/prepare.ts:604-617` passes `--model`, `--effort`, `--max-turns` and
  `--max-budget-usd` through `shellArg`; `src/config/schema.ts:192-194` restricts `model` to a model
  id. Tool lists use `doubleQuote`, which falls back to single quotes (`src/workflows/shell-arg.ts`).

#### SEC-004: MCP "pinned" check can be defeated

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed for the launcher arguments (first seen 2026-11-26; fixed in `8172a42`,
  verified 2026-11-26). The server's `env` is still not checked: see SEC-017.
- **Evidence:** `src/config/mcp-policy.ts:14-142`: the launcher flag tables are allow-lists, any
  unknown flag, a missing value or a mutable git ref makes `isPinned` false, and `--with` extras and
  the launched command are checked too.

#### SEC-005: Direct-mode protected paths are incomplete

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `8172a42`, verified 2026-11-26)
- **Evidence:** `src/workflows/push-direct.ts:18-37` now protects, at any depth and ignoring case,
  `.centaur*`, `.claude*`, `.codex`, `.gemini`, `.cursor`, `.mcp.json`, `.gitmodules`, `AGENTS.md`,
  `CLAUDE.md`, all of `.github/` and CODEOWNERS. No bot in this repo uses direct mode since
  `7b7d222`.

#### SEC-006: Post-agent git steps trust agent-writable state

- **Severity / confidence / effort:** medium / likely / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `src/workflows/push.ts:14-67` and `src/workflows/transplant.ts:48-101` run plain
  `git` in the workspace with no hardening flags; nothing under `src/workflows` sets `core.hooksPath`
  or disables repository config.
- **Impact:** code the agent plants could run in the trusted finish steps.
- **Recommendation:** harden the git invocations now; the full fix is the job split.
- **Tracking:** overlaps `centaur-9af.7`; see also SEC-016 and SEC-019, which have the same root
  cause.

#### SEC-007: Inspection role is broader than read-only inspection needs

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26): documented, not changed
  (`ed5bb4d`). An explicit deny would break `centaur chat tail`, and a required principal would
  break the next deploy until the parameters secret is edited.
- **Evidence:** the inspection role in `infra/centaur.yml`. It can also `Scan` the state table,
  which now holds short-lived Slack search tokens (`search-token:*`).
- **Recommendation:** decide whether to split `chat tail` onto its own role, then deny the secret
  leaf parameters on the inspection role and require an explicit principal.

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
- **Status:** partly done (first seen 2026-11-26; `6b71cc2`, verified 2026-11-26)
- **Evidence:** the S3 calls in `src/workflows/aws.ts:46-52, 175` now go through `runAws`, which masks
  `s3://` URIs, and two warnings use `safeDetail`. The top-level handler `runCli` in
  `src/workflows/program.ts:379-382` still prints any error's `message` as an `::error::` line.
- **Recommendation:** print only `safeDetail(error)` there, or wrap the remaining sources.

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
- **Status:** wontfix 2026-11-26 (first seen 2026-11-26): maintainer prefers major-tag pins (e.g.
  `actions/checkout@v7`) over commit SHAs; accepted risk: a moved upstream tag runs with consumers'
  secrets.
- **Evidence:**
  - `.github/actions/turn/action.yml:54, 109`
  - `.github/actions/setup-runtime/action.yml`
- **Impact:** a moved upstream tag runs in every consumer's turn, with their secrets.
- **Recommendation:** SHA-pin the actions inside `.github/actions` (start with `claude-code-action`).
  Declined; see the status.
- **Notes:** this absorbed the Build & CI finding on action pinning. The install-script and token
  scope recommendations were split out as SEC-015.

#### SEC-015: Install scripts enabled; MCP token scoped to the whole job

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26, split from SEC-013, last verified 2026-11-26)
- **Evidence:**
  - `.yarnrc.yml`: dependency install scripts are not disabled.
  - the job-level `GITHUB_MCP_TOKEN` in `centaur-turn.yml:27`
- **Impact:** a compromised dependency can run code at install time, and every step in the job can
  read the MCP token.
- **Recommendation:**
  - set `enableScripts: false` in `.yarnrc.yml`;
  - move `GITHUB_MCP_TOKEN` to step level;
  - the deploy job is the sharper case: see SEC-018.

#### SEC-014: Access-request rate limit is shared by all subjects

- **Severity / confidence / effort:** info / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/access-request-store.ts:6, 76-85`. The limit is 10 per hour per bot, and an addressed message from an unknown user in an unknown chat now spends two of them (`src/lambda/message-handler.ts:109-117`).
- **Impact:** a stranger can use up the limit, so legitimate requests get "limited".
- **Recommendation:** add a cap per chat or per user.

#### SEC-016: The agent can redirect later trusted steps through `GITHUB_ENV`

- **Severity / confidence / effort:** medium / likely (read from code; not exploited, and not
  confirmed that `claude-code-action` leaves `GITHUB_ENV` in the agent's environment) / S
- **Status:** accepted risk 2026-11-26 (first seen 2026-11-26, in the CLI-locate step added in `fea8855`): the maintainer chose to leave it, because `Bash` is not in the bots' allowed tools, so it only matters if someone enables it. Revisit if `Bash` is enabled for a bot.
- **Evidence:** the first step of `.github/actions/turn/action.yml:32-34` (and `notify-failure`,
  `register`, `resolve-schedule`, `resolve-pr-comment`) writes `CENTAUR_CLI=<path>` to `$GITHUB_ENV`.
  Every later step, from `Audit MCP tool calls` through `finish`, runs `node "$CENTAUR_CLI"`
  (`turn/action.yml:46, 70, 79, 90, 101, 114, 147`). The agent step runs in between.
- **Impact:** an injected agent that is allowed `Bash` can append `CENTAUR_CLI=/path/to/its/script` to
  `$GITHUB_ENV`. The audit, the push steps and `finish` then run its script with their tokens and
  the AWS credentials, and the audit that is meant to catch a bypassed tool gate is itself
  replaced. `GITHUB_PATH` allows the same with `node`. The Write tool is limited to the workspace,
  so this needs `Bash`.
- **Recommendation:** compute the CLI path in each step from `github.action_path` through a
  step-level `env:` value instead of `$GITHUB_ENV`. The job split (`centaur-9af.7`) is the full fix,
  because `GITHUB_PATH` and the built `dist/` stay reachable on a shared runner.

#### SEC-017: MCP `pinned` check and policy ignore a server's `env`

- **Severity / confidence / effort:** medium / confirmed (code and docs; not exploited) / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/config/mcp-policy.ts:145-166` (`describeServer`) builds the policy's `McpServer`
  entity from `command`, `args` and the URL only, and `src/config/mcp-policy-schema.ts:3-12` has no
  `env` or `headers` attribute. `src/config/schema.ts:88-90` lets a local server set any `env`
  strings. `docs/mcp.md:242` mentions `.npmrc` and `uv.toml` as the residual gap but not `env`.
- **Impact:** a consumer config can keep a launcher call pinned and still change what runs, for
  example with `UV_INDEX_URL`, `UV_DEFAULT_INDEX`, `NPM_CONFIG_REGISTRY` or `PIP_INDEX_URL` to
  redirect resolution, or `PATH` and `PYTHONPATH` to run other code. The global policy's
  `pinned` guarantee then does not hold.
- **Recommendation:** treat any `env` key that is not a plain value (or is on a short list of
  resolution and loader variables) as `pinned: false`, and expose the key names in the policy
  entity. Mention the workspace `.npmrc` and `uv.toml` in `docs/mcp.md` as the same class.
- **Notes:** completes SEC-004.

#### SEC-018: Deploy job runs install scripts while the deploy role's OIDC token is available

- **Severity / confidence / effort:** medium / confirmed (reading the workflow; not exploited) / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `.github/workflows/deploy.yml:23-42`. The `deploy` job has `id-token: write` for its
  whole run. Its `install` step (`.github/actions/install/action.yml`, `yarn install --immutable`)
  runs dependency install scripts (`.yarnrc.yml` does not set `enableScripts: false`, see SEC-015),
  then `yarn deploy-prod` runs the build with the AWS credentials in the environment.
- **Impact:** a compromised dependency can request an OIDC token for the `production` environment and
  assume `DeployRole`, which can replace the Lambda code that holds every bot's secrets
  (`docs/deploy.md`, "Residual risk"). This is the same trust as write access to `main`, but it
  widens the set of parties who can use it to anyone who can land a malicious package version.
- **Recommendation:** install with `--mode=skip-build` (or `enableScripts: false`) in the deploy job
  and build only what `deploy-prod` needs; configure the AWS credentials after the build and
  keep `id-token: write` off any step that runs third-party code. Dependabot for `npm` (CI-008)
  would also reduce the exposure.

#### SEC-019: Tool-gate policy, hook settings and entry script are agent-writable (suspicion)

- **Severity / confidence / effort:** medium / speculative (not tested under `claude-code-action`) / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:**
  - `src/workflows/prepare.ts:728-730` writes `tool-policy.json` and the hook settings file under
    `$RUNNER_TEMP/centaur-turn` (`src/workflows/turn-state.ts:18-23, 62-78`) with mode 0600, owned by
    the same user as the agent.
  - `tool-gate.ts:71-90` points `--settings` at that file; the hook runs
    `dist/workflows/cli.js` (`tool-gate.ts:10`), which is inside the workspace for a pull request
    comment turn (`.centaur-trusted/`, `.github/workflows/centaur-comment-turn.yml:66-80`).
  - `tool-audit.ts:11-26` reads the same policy file back, so a changed file defeats the gate and
    the audit together.
- **Impact:** an agent allowed `Bash` could rewrite the policy or the hook script and call MCP
  tools the operator forbade. Without `Bash`, the Write tool cannot reach the temp directory.
- **Recommendation:** have the audit step re-fetch both policy layers (the poster and the default
  branch) instead of reading the saved file, so a tampered file is detected; the job split is the
  full fix. Confirm with a throwaway turn that a `Bash` agent can or cannot write to the state
  directory.
- **Notes:** same root cause as SEC-006 and SEC-016. The 0600 mode protects from other users only.

#### SEC-020: Name-prefix IAM scoping and the legacy deploy subject (suspicion)

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `DeployPolicy` scopes IAM, S3 and policy resources to `${AWS::StackName}-*`
  (`infra/centaur.yml:171-380`), which also matches another stack whose name starts with the same
  prefix. `DeployRole` trust (`infra/centaur.yml:621-641`) also accepts the legacy subject
  `repo:<owner>/centaur:environment:production` without ids.
- **Impact:** with the default stack name `centaur`, a second stack named `centaur-<something>` in the
  same account falls inside the deploy role's reach. The legacy subject form is what SEC-008 warns
  about: it names owner and repository by text, which a renamed or transferred account can
  reuse.
- **Recommendation:** document the one-stack-per-account assumption, or end the prefix with a
  stack-specific separator. Drop the legacy subject once the immutable form is verified (it was
  proved by the first deploy).

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
- **Status:** fixed (first seen 2026-11-26; fixed in `de3ddac`, verified 2026-11-26). The mechanism
  differs from the first recommendation: the platform redelivers rather than the Lambda retrying.
- **Evidence:** `src/lambda/redelivery.ts:42-62` wraps the handler. A failure releases the Chat SDK
  dedupe key and throws `RedeliveryRequested`; `src/lambda/receiver.ts:77-101` drains the
  `waitUntil` tasks, releases the adapter's own marker and answers 500. After `MAX_REDELIVERIES`
  (2) the sender is told to resend and 👀 is removed (`redelivery.ts:49-81`).
- **Notes:** residual risks are REL-018 (a repeated side effect) and REL-019 (time spent before the
  acknowledgement).

#### REL-002: No timeout on outbound `fetch`

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed for the two calls named (first seen 2026-11-26; fixed in `de3ddac`, verified
  2026-11-26). The Slack search call has no timeout: see REL-016.
- **Evidence:** `src/lambda/request-timeout.ts` is used at `src/lambda/github.ts:33` and
  `src/lambda/telegram.ts:37` (10 seconds).

#### REL-003: Rotated GitHub token not picked up by warm containers

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `de3ddac`, verified 2026-11-26)
- **Evidence:** `src/lambda/handler.ts:52-61` (`tokenDispatcher`) reads the token through the
  30-second cached parameter store on every dispatch, in both the receiver and the poster.

#### REL-004: A `prepare` failure gives the user no notice

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `ee4bf69`, verified 2026-11-26)
- **Evidence:** `src/workflows/finish.ts:540-600` falls back to the dispatch `client_payload` when
  there is no turn state, posts the notice, clears 👀, and for comment turns comments on the pull
  request. Scheduled turns have no payload and still post nothing, by design.

#### REL-005: `if: failure()` likely skips job timeouts

- **Severity / confidence / effort:** medium / likely / S
- **Status:** fixed in code (first seen 2026-11-26; fixed in `ee4bf69`, verified 2026-11-26). Not
  confirmed live: nothing here has run a turn past its timeout.
- **Evidence:** `.github/workflows/centaur-turn.yml:41-53` and
  `.github/workflows/centaur-comment-turn.yml:91-111` add a `notify-timeout` job with
  `if: always() && needs.turn.result == 'cancelled'`; the in-job notice stays `failure()`.
  `docs/workflows.md` templates match.
- **Notes:** a manual cancellation of a run also satisfies `cancelled`, so it posts a "did not
  finish" notice too. `.github/workflows/centaur-hello.yml:64` keeps only `failure()`.

#### REL-006: `finish` can post the reply and then fail

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** partly done (first seen 2026-11-26; `ee4bf69`, verified 2026-11-26)
- **Evidence:** `src/workflows/finish.ts:493-510`. The session save is now best effort, and the
  turn state records `replied`, so the failure notice says "I replied, but could not finish
  recording that turn" (`finish.ts:561`). The marker write (`finish.ts:502`) still comes after the
  reply and is unguarded.
- **Impact:** if the marker write fails, the next turn answers the same messages again.
- **Recommendation:** write the marker before delivering, or make that write best effort too.

#### REL-007: An aborted access request blocks its subject for 7 days

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `6b71cc2`, verified 2026-11-26)
- **Evidence:** `src/lambda/access-requests.ts:93-151`: a `finally` removes the stored request and
  releases the slot on any outcome but `raised`, and `access-request-store.ts:86-98` holds the first
  claim for only 5 minutes until `linkSubject` extends it. A process crash between the link and the
  DM still holds the slot, as the commit notes. See REL-017 for a narrow race in the stale-slot path.

#### REL-008: Poster's MCP resume dispatch skips the failure notice

- **Severity / confidence / effort:** low / confirmed / M
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:**
  - `src/lambda/handler.ts:90` still passes the raw token dispatcher to the poster, which goes
    against the `createBotChat` rule in `AGENTS.md`.
  - `src/lambda/mcp-approvals.ts:153-158` dispatches through it (with the self-identity added).

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

#### REL-015: Two bots that accept each other's mentions can loop without a cap

- **Severity / confidence / effort:** low / confirmed (documented, not exercised) / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/ownership.ts:28` owns a bot-authored message that mentions the bot when
  `bot_messages` is `mention`; `src/lambda/message-handler.ts:101-134` then only needs the other bot
  to be an approved user. `docs/plan.md:257-261` says there is no hop or loop cap, and that
  per-turn spend caps and the agent not re-mentioning the other bot are the only brakes. The
  self-test bots on Slack are configured this way (`TODO.md`).
- **Impact:** a prompt-injected or confused reply that mentions the other bot starts a loop that
  costs a turn per message until someone stops it.
- **Recommendation:** count bot-authored hops per thread in the state store and stop at a small
  limit, or require a human message to reset the count.

#### REL-016: The Slack search call has no timeout

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/slack-search.ts:55-72` calls `fetch` without `signal`, unlike
  `github.ts` and `telegram.ts` (REL-002).
- **Impact:** a hung search uses up the poster's 30s and returns a generic Lambda timeout to the
  agent instead of the `rate_limited` or `unavailable` results it understands.
- **Recommendation:** pass `requestTimeout()` from `src/lambda/request-timeout.ts`.

#### REL-017: The stale-slot release in access requests can race (suspicion)

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/access-requests.ts:87-92` releases a stale slot and claims it again;
  `src/lambda/access-request-store.ts:120-123` deletes the slot key without checking what it holds.
  Two concurrent messages that both find the same stale slot can each release and claim in turn.
- **Impact:** the second release removes the first caller's fresh claim, so two requests (and two
  DMs) can be raised for one subject.
- **Recommendation:** make `releaseSubject` conditional on the slot still pointing at the stale
  request id.

#### REL-018: A redelivered message can dispatch twice (suspicion)

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/redelivery.ts:36-41` states that a handler that failed after a side
  effect repeats it. The dispatch is the last step of `src/lambda/message-handler.ts:158`, but a
  10-second timeout (`src/lambda/github.ts:33`) can abort a dispatch that GitHub already accepted.
- **Impact:** the platform redelivers, and the message starts a second turn. The thread's
  concurrency group serializes the two, and the processed marker normally makes the second a no-op,
  but a second turn queued while the first is still running can answer the same message again.
- **Recommendation:** treat a timeout on the dispatch as unknown and check the marker, or record a
  per-message dispatch key before dispatching.

#### REL-019: Time spent before the acknowledgement (suspicion)

- **Severity / confidence / effort:** low / speculative / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/receiver.ts:76-89` drains every `waitUntil` task before returning, so
  the response waits for the whole handler: the attachment save, the search token write, the
  identity lookup (`src/lambda/self-identity.ts:41-47, 64-83`, up to 2 seconds, and a failed lookup
  is not cached) and the dispatch (up to 10 seconds).
- **Impact:** Slack's acknowledgement budget is about 3 seconds. A slow step makes Slack redeliver;
  the adapter's marker (`slack:event-delivered:*`) and the dedupe key drop the duplicate, so the
  cost is repeated work rather than a lost or double message. This is the open question under
  REL-001 about how often Slack acknowledgements are slow.
- **Recommendation:** measure first. If acks are slow, read the identity from a cache on the
  dispatch path only and start the dispatch before the optional steps.

### Architecture

**Status:** minor issues. The Lambda bundle boundary holds: nothing in `src/lambda` imports the
runner or the MCP code. Contracts between the Lambda and the runner are defined twice.

**Coverage:**

- **Runner:** most of `src/workflows`.
- **Lambda:** the poster, chat context, parameters, access, register and GitHub modules.
- **Config:** `src/config`.
- **CLI and MCP:** parts of `src/cli` and `src/mcp`.
- **Scans:** import graph, casts, duplicated literals.

Most `AGENTS.md` "update N places" rules can be traced to ARCH-002, 003, 004 and 007 (ARCH-006 is fixed).

#### ARCH-001: Runner imports Lambda runtime modules for constants

- **Severity / confidence / effort:** medium / confirmed / S-M
- **Status:** fixed (first seen 2026-11-26; fixed in `1bf6317`, verified 2026-11-26)
- **Evidence:** `src/poster-contract.ts` (zod and config only) and `src/text.ts` are imported by
  both sides. `src/workflows` and `src/mcp` import nothing at runtime from `src/lambda`; the one
  remaining reference is the type-only `import type { PosterRequest }` at `src/workflows/aws.ts:8`.
  `src/cli` still imports Lambda modules, by design.

#### ARCH-002: Poster results are untyped on the runner

- **Severity / confidence / effort:** medium / confirmed / M
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26; the list-threads, read-channel,
  search-chat and MCP-approval results now have schemas in `src/poster-contract.ts`)
- **Evidence:**
  - `src/workflows/aws.ts:58, 85, 148` (`call<T = unknown>`, then `z.custom` for the result);
  - the `resolve-pull-request` result is redeclared in `prepare.ts:475`, `pr-target.ts:114` and
    `resolve.ts:137`;
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
- **Status:** fixed (first seen 2026-11-26; fixed in `1bf6317`, verified 2026-11-26)
- **Evidence:** the shape is `chatMessageSchema` and `ChatMessage` in `src/poster-contract.ts:68-139`;
  `src/workflows/transcript.ts:2` and `src/mcp/chat-server.ts:4` import the type. The two Lambda
  mappers remain but build that one shape (`src/lambda/chat-context.ts:81-96`).

#### ARCH-007: Lambda `register` parses the full config schema

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/register.ts:39` parses the full schema but uses only `bot` and
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
  - encoded again in `src/lambda/access-requests.ts:239`;
  - decoded in two different ways, in `src/workflows/mcp-approval.ts:74` and `connection-paths.ts`.

#### CODE-005: Dispatch payload schema defined on each side

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/lambda/message-handler.ts:22-33` and `src/workflows/prepare.ts:95-103`.

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
  - `src/workflows/turn-state.ts:60, 72` (`JSON.parse(...) as TurnState` and `as ToolPolicyState`, the latter read by the tool gate)
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
per test. But several tests still mirror YAML.

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
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** `test/turn-action.test.ts:9-85` asserts step IDs, `if:` strings and env-key lists
  as literals.
- **Recommendation:** replace with the correspondence test in TEST-006, then delete these. Also
  update the `AGENTS.md` line that names this file.

#### TEST-003: `infra.test.ts` mixes mirrors with correspondence tests

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `695b953`, verified 2026-11-26)
- **Evidence:** `test/infra.test.ts` is now four short `describe` blocks (the Lambda role's
  parameter permissions, the state table, the receiver's environment); the code side of each
  comes from the code and `test/helpers/infra-fixtures.ts`.

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
- **Status:** fixed (first seen 2026-11-26; fixed in `695b953`, verified 2026-11-26)
- **Evidence:** the program moved to `src/workflows/program.ts` with an exported `runCli`, and
  `src/workflows/cli.ts` is two lines; `test/workflow-cli.test.ts` runs commands against fakes.
- **Notes:** the correspondence check between each command's env names and each `action.yml` step
  was not added; that part of the recommendation remains optional.

#### TEST-007: Fake AWS never validates requests against the poster schema

- **Severity / confidence / effort:** medium / likely / S
- **Status:** fixed (first seen 2026-11-26; fixed in `695b953`, verified 2026-11-26)
- **Evidence:** `test/helpers/workflow-fixtures.ts:62` runs `posterRequestSchema.parse(request)`.

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

The CD deploy role and `scripts/setup-cd.sh`, both added in `942d0d7`, were reviewed on
2026-11-26 (`deploy.yml`, `ci.yml`, `DeployRole`, `DeployPolicy`): see SEC-018, SEC-020 and CI-011.
The live state of the `main` ruleset and the `production` environment was not re-checked in this
run; the CI-002 evidence below is from the first run.

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
- **Notes:** continuous deployment raises the stakes. A commit that lands on `main` deploys
  automatically, and the `production` environment has no required reviewers
  (`scripts/setup-cd.sh` restricts only the branch), so a merge with 0 approvals and no required
  check is production code execution (`docs/deploy.md`, "Threat model"). `ci.yml` no longer has a
  `push` trigger (`2f839a6`), so the required check must be the pull request `verify` job, not
  `verify / verify`.

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
- **Recommendation:** cut a moving tag (such as `v0`) for centaur's own actions after each verified
  deploy, or reword the doc to say to pin `@main` for the latest, or a tag. The maintainer pins by
  tag rather than SHA (see SEC-013).

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

#### CI-011: A manual deploy can redeploy any older commit on `main`

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `.github/workflows/deploy.yml:5-9, 29-34`. `workflow_dispatch` takes a `ref` and the
  only check is that it is an ancestor of `origin/main`.
- **Impact:** someone who can dispatch the workflow on `main` can roll the stack back to an older
  commit, for example one before a security fix, without any review. That is within the trust
  already granted to write access (`docs/deploy.md`), but it is a quiet way to undo a fix.
- **Recommendation:** accept only the tip of `main` (or require it for a push), or put required
  reviewers on the `production` environment.

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

**Status:** minor issues. The reference docs mostly match the code, and every relative link and
anchor resolves (about 420 were checked). Two task trackers contradict each other. The committed
private identifiers have been fixed.

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

#### DOCS-001: A real chat identifier is committed

- **Severity / confidence / effort:** high / confirmed / S
- **Status:** fixed 2026-11-26 (first seen 2026-11-26)
- **Evidence:** two branch names in `DONE.md`
- **Impact:** breaks the `AGENTS.md` rule that keeps chat IDs out of the repo.
- **Recommendation:** replace the ID with a placeholder.
- **Notes:** 2026-11-26:
  - The chat ID was replaced with a placeholder. The maintainer chose not to scrub git history.
  - The `garden` repository is public, so references to it stay (false positive).

#### DOCS-002: `TODO.md` names personal consumer repositories and their purpose

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed 2026-11-26 (first seen 2026-11-26)
- **Evidence:** three "Setup .centaur config" items in `TODO.md`
- **Recommendation:** reword them generically, or move them to a private tracker.
- **Notes:** 2026-11-26: reworded generically. `~/dev` paths are generic and fine to keep.

#### DOCS-003: A Slack fixture may use a real channel ID

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** fixed 2026-11-26 (first seen 2026-11-26)
- **Evidence:** `test/helpers/slack-fixtures.ts:23`, and one literal in
  `test/access-decisions.test.ts`. The other fixtures use obvious placeholders.
- **Recommendation:** switch to an obvious placeholder.
- **Notes:** 2026-11-26: confirmed real by matching it against `centaur destination list` and
  `centaur access list` output, without printing any IDs. Replaced with `C0TESTCHAN1`. It remains
  in git history.

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
- **Status:** fixed (first seen 2026-11-26; fixed in `1c89248`, verified 2026-11-26)
- **Evidence:** `CLAUDE.md` now has a "Repository instructions" section that points to `AGENTS.md`,
  gives the setup and `yarn verify` commands, and links `docs/plan.md` and `TODO.md`.
- **Impact:** Claude Code loads `CLAUDE.md`, so it misses every rule in `AGENTS.md`.
- **Recommendation:** replace the placeholders with `@AGENTS.md`, or symlink `CLAUDE.md` to
  `AGENTS.md`.

#### DOCS-006: The reactions skill shows the wrong emoji for a Slack denial

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `1c89248`, verified 2026-11-26)
- **Evidence:** `skills/centaur-reactions/SKILL.md:3, 20` now say 🚫, matching
  `src/lambda/approval-reactions.ts:24` (`no_entry_sign`).

#### DOCS-007: README and onboarding still say Slack is unverified

- **Severity / confidence / effort:** medium / confirmed / S
- **Status:** fixed (first seen 2026-11-26; fixed in `1c89248`, verified 2026-11-26)
- **Evidence:** `docs/onboarding.md:5-6` now says Slack ran live on two bots, with the remaining
  steps listed under "Still unverified" (`docs/onboarding.md:364`); `README.md:124` points to
  that list.

#### DOCS-008: `docs/workflows.md` omits three workflow CLI commands

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:**
  - `docs/workflows.md:449` doesn't list `plan-pr`, `push-existing` or `push-direct`, which are
    defined in `src/workflows/program.ts` (the commands moved there from `cli.ts`).
  - Line 443 still has the typo "theactions".

#### DOCS-009: `config check --root` is not documented

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26)
- **Evidence:** `src/cli/commands/config.ts:34` defines the flag; `docs/cli.md:341` doesn't mention
  it.

#### DOCS-010: `docs/config.md` miscounts the per-platform keys

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** fixed (first seen 2026-11-26; became moot when `84aeb5d` dropped the `handle` key,
  verified 2026-11-26)
- **Evidence:** `docs/config.md:98` says "two optional keys", and the schema has two
  (`respond_to`, `bot_messages`, `src/config/schema.ts:99-102`).

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
- **Status:** partly done (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:** the table in `docs/plan.md#ssm-parameter-layout` now has the MCP approvals row
  (`:427`) but still lacks the approvers and `/centaur/state-table`.

#### DOCS-013: Finished design docs name files that don't exist

- **Severity / confidence / effort:** low / confirmed / S
- **Status:** open (first seen 2026-11-26, last verified 2026-11-26)
- **Evidence:**
  - `docs/platforms-and-destinations.md:505-508, 581` (files such as `chat-aliases.ts` and
    `commands/destination.ts`);
  - `docs/chat-context.md:263`, which names `src/mcp/chat-server-main.js`.
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

- `src/workflows/finish.ts` validation of agent output (`start` targets, PR targets) and
  `pr-target.ts`/`checkCandidate`, both in depth;
- the tool surface of `src/mcp/chat-server.ts` (the `search_chat` tool in particular);
- `src/cli/**` beyond the parameter store and destinations;
- the Chat SDK adapters' own outbound timeouts and retries;
- performance;
- the data model (the SSM layout and DynamoDB keys, which were inspected only as needed for
  security);
- the live state of GitHub settings (the `main` ruleset, the `production` environment) and of the
  deployed stack: this run read code and docs only.

**Open questions that need runtime access or the maintainer:**

- In headless runs, does Claude Code load the workspace `.mcp.json` and `.claude/settings.json` when
  `--setting-sources` is unset? Does `--setting-sources user` also stop it loading the workspace
  `CLAUDE.md`? Can its Write tool write under `.git/`?
- Does `claude-code-action` leave `GITHUB_ENV`, `GITHUB_PATH` and `RUNNER_TEMP` reachable to a
  `Bash` tool call, and does it honor `onFailure: "block"` in a hook? (SEC-016, SEC-019, and the
  live confirmation of the tool gate.)
- Does a job that hits `timeout-minutes` report `cancelled` to `needs.turn.result`? (REL-005, now
  assumed in `notify-timeout`.)
- How often does "Message processing error" appear in CloudWatch, how often does the receiver
  answer 500 for redelivery, and how many Slack acks take longer than 3s? (REL-001, REL-019)
- Do any external consumers run `@main` today? This sets the urgency of CI-002.
- Should PRs from scheduled prompts and new threads be eligible as update targets? (CODE-002)
- Should the stack template default `RequirePosterToken` to `true`? (SEC-001)

## Inspection log

- 2026-11-26 `05cbef6` to `5b61006`: first run.
  - Areas inspected: security, reliability, architecture and code quality, testing, build & CI,
    dependencies, and docs & DX.
  - Results: 85 findings, of which 3 were already fixed by commits that landed during the audit
    (CI-001, CI-003, TEST-001).
  - Verification: every high finding was re-checked at `5b61006`, as were DOCS-002, DOCS-005 and
    DOCS-006.
  - Not covered: the CD changes from `942d0d7`.
- 2026-11-26: SEC-013 reclassified wontfix by maintainer decision (third-party actions are pinned by
  major tag, not commit SHA); 1 finding split out (SEC-015). CI-006 recommendation updated.
- 2026-11-26 `5b61006` to `33f395c`: refresh.
  - Re-verified against the code: every finding that was open or partly done.
  - Statuses changed: fixed SEC-001 (deployment setting), SEC-003, SEC-004 (launcher arguments),
    SEC-005, REL-001 to REL-005, REL-007, ARCH-001, ARCH-006, TEST-003, TEST-006, TEST-007,
    DOCS-005, DOCS-006, DOCS-007, DOCS-010; partly done SEC-010, REL-006, DOCS-012.
  - New findings from a focused pass on code merged since `5b61006`: SEC-016 to SEC-020, REL-015 to
    REL-019, CI-011. Areas read: the continuous deployment workflows and `DeployRole`, the per-call
    MCP gate and audit, the Slack search token and `search-chat`, access requests, `ownsMessage` and
    `bot_messages`, self-identity, repository instructions, the CLI-locate step, the redelivery
    wrapper.
  - Not verified: anything that needs live GitHub, AWS or `claude-code-action` behavior (see the open
    questions above). The suspicions (SEC-019, SEC-020, REL-017 to REL-019) are marked as such.
