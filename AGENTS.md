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
- A new field in the agent's structured output goes in three places: `replySchema`
  (`src/workflows/prompt.ts`), `resultMessage` and `extractResult` (`src/workflows/finish.ts`), and
  `docs/workflows.md`. The PR step in `.github/actions/turn/action.yml` reads the `pr-details` outputs.
