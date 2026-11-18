# AGENTS.md

## Workflow experiments

- GitHub can only dispatch workflows that exist on the default branch. Keep a minimal
  `workflow_dispatch` stub on `main`, develop the real workflow on an `experiment/*` branch, and
  run it with `gh workflow run <file> --ref <branch>`.
- A branch checked out in another worktree can't be checked out here; reuse that worktree or
  remove it first.

## Task lists

- [TODO.md](TODO.md) holds work agents can do. [HUMAN_TODO.md](HUMAN_TODO.md) holds what only the
  maintainer can do (accounts, live bots, decisions). When work stalls on a human step, add it to
  `HUMAN_TODO.md` and keep it out of `TODO.md`.

## Development

- TypeScript (ESM, Node 24 to match the Lambda runtime; see `.nvmrc`). Run `npm ci` once.
- `npm run lint` (Biome check: lint, format, import order; `npm run format` fixes), `npm run
  typecheck`, `npm test` (Vitest, `test/**/*.test.ts`), `npm run build` (tsc to `dist/`).
- `npm test` starts `amazon/dynamodb-local` through Docker, or uses `DYNAMODB_ENDPOINT` if set.
- CloudFormation templates in `infra/` are validated with cfn-lint, pinned in
  `requirements-dev.txt`. One-time setup: `pyenv install 3.10.9` if missing (see `.python-version`),
  then `python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`. Run `npm run lint:cfn`.
- CLI (`src/cli/`, bin `centaur`): all SSM access goes through the `ParameterStore` interface in
  `src/cli/parameter-store.ts`; tests use `test/helpers/fake-parameter-store.ts`. The SSM parameter
  layout is in `docs/plan.md`. Never accept secrets as flags.
- `npm run bundle:lambda` builds the Lambda to `dist/lambda/index.mjs`; `scripts/deploy.sh`
  (`npm run deploy-prod`) bundles, uploads and deploys the stack (see `docs/deploy.md`).
- Biome covers code and JSON only; Markdown and YAML are not auto-formatted.
- Chat SDK slash commands (`onSlashCommand`) bypass the message handler and its allowlist, so each
  slash handler authorizes itself and falls back to `processMessage` for anything it doesn't own.
- The Lambda `ParameterStore` (`src/lambda/parameters.ts`) and the CLI one
  (`src/cli/parameter-store.ts`) are separate interfaces; adding a method means updating
  `fakeParameterStore` (`test/helpers/receiver-fixtures.ts`) or `FakeParameterStore`.
- Run `npm run lint:cfn` after IAM or template changes; set up with `python3 -m venv .venv &&
  .venv/bin/pip install -r requirements-dev.txt`.
