# AGENTS.md

## Workflow experiments

- GitHub can only dispatch workflows that exist on the default branch. Keep a minimal
  `workflow_dispatch` stub on `main`, develop the real workflow on an `experiment/*` branch, and
  run it with `gh workflow run <file> --ref <branch>`.
- A branch checked out in another worktree can't be checked out here; reuse that worktree or
  remove it first.

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
- Biome covers code and JSON only; Markdown and YAML are not auto-formatted.
