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
- Biome covers code and JSON only; Markdown and YAML are not auto-formatted.
