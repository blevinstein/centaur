# AGENTS.md

## Workflow experiments

- GitHub can only dispatch workflows that exist on the default branch. Keep a minimal
  `workflow_dispatch` stub on `main`, develop the real workflow on an `experiment/*` branch, and
  run it with `gh workflow run <file> --ref <branch>`.
- A branch checked out in another worktree can't be checked out here; reuse that worktree or
  remove it first.

## Task lists

- [TODO.md](TODO.md) holds all open work, agent and human. Items needing the maintainer are labeled
  **[HUMAN ACTION]** (only the maintainer can do it: accounts, credentials, messaging the live bot)
  or **[HUMAN APPROVAL]** (an agent prepares it, the maintainer approves before it lands: decisions,
  merges, changes that deploy to CloudFormation). When work stalls on one, add it to `TODO.md` with
  the label and what it unblocks; don't do or skip it silently.
- [TODONE.md](TODONE.md) holds completed sections: move a section there, whole, once every item in it is
  checked; never move individual items.

## Development

- TypeScript (ESM, Node 24 to match the Lambda runtime; see `.nvmrc`). Run `corepack enable` and
  `yarn install --immutable` once; Corepack uses the Yarn version pinned in `packageManager` in
  `package.json`.
- Yarn does not auto-install peer dependencies; when a tool fails with `ERR_MODULE_NOT_FOUND` for a
  peer (e.g. `vite` for vitest), add it to devDependencies explicitly. Yarn Berry has no `--silent`
  flag.
- `yarn lint` (Biome check: lint, format, import order; `yarn format` fixes), `yarn typecheck`,
  `yarn test` (Vitest, `test/**/*.test.ts`), `yarn build` (tsc to `dist/`).
- `yarn test` starts `amazon/dynamodb-local` through Docker, or uses `DYNAMODB_ENDPOINT` if set.
- CloudFormation templates in `infra/` are validated with cfn-lint, pinned in
  `requirements-dev.txt`. One-time setup: `pyenv install 3.10.9` if missing (see `.python-version`),
  then `python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`. Run `yarn lint:cfn`.
- CLI (`src/cli/`, bin `centaur`): all SSM access goes through the `ParameterStore` interface in
  `src/cli/parameter-store.ts`; tests use `test/helpers/fake-parameter-store.ts`. The SSM parameter
  layout is in `docs/plan.md`. Never accept secrets as flags.
- `yarn bundle:lambda` builds the Lambda to `dist/lambda/index.mjs`; `scripts/deploy.sh`
  (`yarn deploy-prod`) bundles, uploads and deploys the stack (see `docs/deploy.md`).
- Biome covers code and JSON only; Markdown and YAML are not auto-formatted.
- Chat SDK slash commands (`onSlashCommand`) bypass the message handler and its allowlist, so each
  slash handler authorizes itself and falls back to `processMessage` for anything it doesn't own.
- The Lambda `ParameterStore` (`src/lambda/parameters.ts`) and the CLI one
  (`src/cli/parameter-store.ts`) are separate interfaces; adding a method means updating
  `fakeParameterStore` (`test/helpers/receiver-fixtures.ts`) or `FakeParameterStore`.
- Run `yarn lint:cfn` after IAM or template changes; set up with `python3 -m venv .venv &&
  .venv/bin/pip install -r requirements-dev.txt`.
- `src/lambda/handler.ts` builds the receiver and poster lazily at module scope. Test it with
  `importFreshHandler()` from `test/helpers/handler-fixtures.ts`, which resets modules. Declare the
  `vi.mock` calls for the factory modules in the test file, because `vi.mock` only hoists there.
- The receiver's `ParameterStore` is wrapped by `createCachedParameterStore`
  (`src/lambda/cached-parameters.ts`, 30s). `getByPath` and admin-claim reads are deliberately
  uncached; the poster and register paths use the raw store.
- The dispatch payload carries `thread_key` (`src/thread-key.ts`, the 12-hex hash of bot and thread
  ID), which the concurrency group and the PR branch use instead of raw thread IDs. A new public
  name that would embed a thread ID must use `threadKey`, and a payload change must also update
  `centaur-message.yml`, the template in `docs/workflows.md`, and `docs/plan.md`.
- The state adapter is the published `@blevinstein/chat-state-dynamodb` package (a fork of the
  community one; see its README). Its `TABLE_DEFINITION` and `TTL_ATTRIBUTE` define the test table,
  and `test/infra.test.ts` checks them against `infra/centaur.yml`.
- Poster operations that act for a repository take it from the verified OIDC claim, never the
  payload; their strict schemas reject extra keys. Use `createState("")` for cross-bot records.
- A new field in the agent's structured output goes in three places: `replySchema`
  (`src/workflows/prompt.ts`), `resultMessage` and `extractResult` (`src/workflows/finish.ts`), and
  `docs/workflows.md`. The PR step in `.github/actions/turn/action.yml` reads the `pr-details` outputs.
- Agent prompt guidance lives in `src/workflows/instructions/*.md` (copied to `dist/` by
  `yarn build`) and is overridable via the config's `instructions`. Anything the code parses or
  that guards untrusted input stays in `prompt.ts`, not in those files.
- PR comment turns: `resolve` (`src/workflows/resolve.ts`) gates them and never outputs the raw thread
  ID. `COMMENT_PULL_REQUEST` enables comment-mode `prepare`; `src/workflows/pull-request-comments.ts`
  owns PR reading and comment rendering. Every comment the agent posts to a PR carries
  `REPLY_MARKER`, and `finish` pushes with plain `git`.
- `pull_requests.comment_authors` (default OWNER/MEMBER/COLLABORATOR) gates comment turns twice:
  `resolve` checks the event's `author_association` through the lazy `commentAuthors` dep (config
  read from the default-branch checkout), and `prepare` filters pending comments and inline thread
  context by `PullRequestComment.association`. Unlisted humans are omitted, not fenced; a new
  comment source must set `association`. A new config key also needs `docs/config.md`, the defaults
  in `test/config.test.ts` and any fixture that builds the config by hand.
- Test a thread branch (`centaur/<bot>-<thread key>[-<run id>-<attempt>]`) only with
  `isThreadBranch` (`src/workflows/resolve.ts`), never `startsWith`: a bot name can prefix
  another's (`sprout`, `sprout-2`).
- `mcp_servers` are checked against the Cedar policy `.centaur/mcp-policy.cedar` as it exists on the
  repository's default branch, fetched through the GitHub API (`src/workflows/mcp-policy-check.ts`),
  never the workspace copy, because a turn can run on any branch, merged with the global
  `infra/mcp-policy.cedar` (zipped by `scripts/deploy.sh`, served by the poster's `get-mcp-policy`).
  `prepare` and `registerRepo` run the check before any other poster call and fail closed. Keep `src/config/mcp-policy.ts` (cedar-wasm,
  runner-only) out of the Lambda bundle: do not re-export it from `src/config/index.ts`.
- `PrepareDeps.env` carries the secrets named in `mcp_servers`; `prepare` fails before any poster
  call if one is unset. Tests that need git use `test/helpers/git-fixtures.ts`.
- Comment turns run the actions and read the config (`.centaur.yml` or `.centaur/config.yml`), the persona and the instructions from a
  default-branch checkout (`.centaur-trusted`, via `config_root`); the PR branch is the workspace
  root. Don't use `./.github/actions` in a job that checks out untrusted code.
- The structured-output fields `pr_action` and `existing_pr_number` are gated by the
  `pull_requests` config; `prTargetFlags(config)` in `src/workflows/prepare.ts` feeds both the
  schema and the prompt. `checkCandidate` in `src/workflows/pr-target.ts` is the only place a PR
  target is validated; never trust a PR number from the turn state. The turn state lives outside the workspace
  (`src/workflows/turn-state.ts`, `$RUNNER_TEMP/centaur-turn/`); pass `stateDir`, never a workspace path, to `finish`, `notifyFailure` and `describePullRequest`.
- A value that reaches `finish` through the turn action needs both an env entry in
  `.github/actions/turn/action.yml` and a dep in the `finish` command in `src/workflows/cli.ts`.
  `plan-pr` and `finish` get `CENTAUR_CONFIG_ROOT` from `inputs.config_root`
  (`test/turn-action.test.ts`).
- Tests must not synchronize on side-effecting probes such as `acquireLock`; wait on a gate the
  handler opens, and fake `Date` instead of sleeping past a TTL.
- Read the config only through `findConfigFile`/`readConfigText` (`src/workflows/config-file.ts`);
  never hard-code a config path. `.centaur/config.yml` and `.centaur.yml` are both supported.
- State adapters reject calls before `connect()`. `ReceiverDeps` and `PosterDeps` take
  `createState(keyPrefix)`, and the code connects each adapter with `connectState`
  (`src/lambda/state.ts`): the receiver once at startup, the poster through a per-prefix cache of
  connected adapters (a failed connect is dropped so the next request retries). `Chat` calls
  `connect()` on the same instance again, which is a no-op. Tests that need the adapter contract
  (calls reject before `connect()`) use `test/helpers/strict-state.ts`.
