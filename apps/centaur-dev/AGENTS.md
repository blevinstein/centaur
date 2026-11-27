# AGENTS.md

This is `centaur-dev`, run from `apps/centaur-dev` to develop this repository. The top-level
`AGENTS.md` applies; these rules add what is specific to this bot:

- Run `yarn verify` before finishing any change, and state the result in `pr_body`. Pull requests
  opened with the job's `GITHUB_TOKEN` trigger no workflows, so nothing else tests the change before
  review.
- Never run `git commit`, `git push` or `gh pr create`; leave edits in the working tree and set
  `pr_title` and `pr_body` so the harness opens the pull request.
- Changes under `.github/workflows/` cannot be pushed with the job token (it has no `workflows`
  permission); describe such a change in the reply instead of editing `.github/workflows/`.
- If `bd` is installed, run it read-only (`bd --readonly ...`); task status changes belong to the
  maintainer.
