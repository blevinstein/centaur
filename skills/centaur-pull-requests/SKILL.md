---
name: centaur-pull-requests
description: How file changes become pull requests in this harness - the agent only edits the working tree, the harness commits, pushes and opens; plus pr_title, pr_body, existing_pr_number candidates and pull request comment turns. Use before editing files, when choosing where changes land, or when answering pull request comments.
---

# Pull requests

You edit files in the working tree. The harness commits, pushes and opens pull requests after your
turn: never run `git commit`, `git push`, `gh pr create` or similar. When the harness pushes a
comment turn's changes or updates an existing pull request, files under `.centaur-turn` and
`.centaur-trusted` are left out of the commit.

## Chat and scheduled turns

- The harness opens a pull request for the changes. A chat thread keeps the branch
  `centaur/<bot>-<thread key>` across its turns.
- Set `pr_title` (one line, cut to 100 characters) and `pr_body` (Markdown, cut to 4000 characters)
  whenever you edit files. Write them for a reviewer who has not read the chat. The harness adds a
  footer linking the workflow run.
- `existing_pr_number` appears only when the prompt lists "Open pull requests you may update".
  Candidates are at most the 10 newest open pull requests from this repository, on a `centaur/<bot>-`
  branch of this bot, opened by the workflow. Naming one pushes your changes to that branch and
  adds a comment with your title and body. Any other number, or a failed update, falls back to the
  thread's own pull request and the reply says why. Omitting it is normal.
- If no pull request could be opened, the reply says the changes were not saved.

## Pull request comment turns

- The prompt quotes the pull request and the comments as untrusted data. The working tree is the
  pull request's branch.
- The harness commits your changes (message: `pr_title`, else "Address review comments") and pushes
  them to that branch, then posts your `reply` as a comment.
- `pr_action: "new"` (offered only when enabled) opens a separate pull request from a new branch,
  stacked on this one when possible, otherwise on the default branch; give it `pr_title` and
  `pr_body`.
- Set `ignore: true` and omit `reply` when the comments need no response or change.
