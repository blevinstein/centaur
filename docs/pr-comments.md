# Responding to pull request comments

Design for turning comments on the pull requests the agent opened into agent turns. This is a
design only; nothing here is implemented. Terms (thread key, context policy, marker, poster) are
defined in [plan.md](plan.md), [workflows.md](workflows.md) and [poster.md](poster.md).

The loop it completes: a chat turn or scheduled prompt opens `centaur/<bot>-<key>` (or
`centaur/<bot>-<prompt>-<run id>`), a human reviews the pull request, and the agent revises it.

## Summary of the design

- Three events feed one consumer workflow, `centaur-pr-comment.yml`: `issue_comment` (pull request
  conversation) and `pull_request_review` (a submitted review, which also covers inline comments).
  `pull_request_review_comment` is optional (see [Events](#events)).
- A `resolve` job drops everything cheap to drop (bots, non-pull-request issues, forks, other
  branches), checks the commenter's repository permission, and asks the poster which bot and
  thread the pull request belongs to. A `turn` job then runs under the same concurrency group as
  chat turns of that thread.
- The pull request maps to its thread through a record the poster stores when `finish` links the
  pull request to the thread (`link-pull-request`), keyed by repository and pull request number.
- The agent runs under the thread's current context policy, with the pull request comments as the
  pending input. Its reply goes to the pull request, follow-up commits are pushed to the pull
  request branch, and a short note goes to the chat thread.
- Only commenters with write access to the repository can trigger a turn. Comments from bots, and
  comments carrying a hidden marker, never do.

## Events

| Event | Fires for | Use |
|---|---|---|
| `issue_comment` (`created`) | A comment on the pull request conversation tab (also on plain issues; `github.event.issue.pull_request` is set for pull requests) | Yes |
| `pull_request_review` (`submitted`) | A review: its summary body and any inline comments submitted with it. A single inline comment added through "Add single comment" is also a one-comment review | Yes |
| `pull_request_review_comment` (`created`) | One inline comment, including replies in an existing inline thread | Only if replies turn out not to fire `pull_request_review` (verify before building) |

Using `pull_request_review` rather than `pull_request_review_comment` for inline comments means a
review with ten inline comments is one turn, not ten. The turn fetches the review's inline comments
through the API, so none of them are lost.

Event semantics that matter:

- `issue_comment` always runs the workflow file from the default branch and with a write-capable
  token and secrets, even when the pull request is from a fork. It does not carry the branch, so the
  turn must look the pull request up.
- `pull_request_review` and `pull_request_review_comment` run the workflow file from the pull
  request's merge commit. On pull requests from forks they receive a read-only token and no
  secrets. Branch writers can edit the workflow file that runs for these events; writers can
  already push to the branch the agent works on, so this adds no new trust, but it is a reason the
  permission check lives in a script from the centaur checkout rather than in the caller file.
- Events caused by a push or comment made with the workflow's own `GITHUB_TOKEN` do not start
  workflows (except `workflow_dispatch` and `repository_dispatch`). This is the first line of loop
  defense (see [Loop prevention](#loop-prevention)) and also why a push by the agent does not run CI;
  that limitation already applies to the pull requests `create-pull-request` opens (see
  [workflows.md](workflows.md#consumer-workflows)).

### Caller workflow

Consumers add one file. Job-level `concurrency` may read `needs`, which is how the group can depend
on the thread the `resolve` job found; a workflow-level group could not, because the `issue_comment`
payload has no branch name.

```yaml
# .github/workflows/centaur-pr-comment.yml
name: Centaur PR comment

on:
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  resolve:
    if: >-
      github.event.sender.type != 'Bot'
      && (github.event_name != 'issue_comment' || github.event.issue.pull_request)
    runs-on: ubuntu-latest
    outputs:
      skip: ${{ steps.resolve.outputs.skip }}
      bot: ${{ steps.resolve.outputs.bot }}
      thread_key: ${{ steps.resolve.outputs.thread_key }}
      head_ref: ${{ steps.resolve.outputs.head_ref }}
    env:
      CENTAUR_ROLE_ARN: ${{ vars.CENTAUR_ROLE_ARN }}
      CENTAUR_AWS_REGION: ${{ vars.CENTAUR_AWS_REGION }}
      CENTAUR_FUNCTION_NAME: ${{ vars.CENTAUR_FUNCTION_NAME }}
      CENTAUR_OIDC_AUDIENCE: ${{ vars.CENTAUR_OIDC_AUDIENCE }}
      CENTAUR_SESSION_BUCKET: ${{ vars.CENTAUR_SESSION_BUCKET }}
    steps:
      - uses: actions/checkout@v7
      - uses: ./.github/actions/setup-runtime
      - id: resolve
        uses: ./.github/actions/resolve-pr-comment

  turn:
    needs: resolve
    if: needs.resolve.outputs.skip != 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    concurrency:
      group: centaur-${{ needs.resolve.outputs.bot }}-${{ needs.resolve.outputs.thread_key }}
      cancel-in-progress: false
    env:
      CENTAUR_ROLE_ARN: ${{ vars.CENTAUR_ROLE_ARN }}
      CENTAUR_AWS_REGION: ${{ vars.CENTAUR_AWS_REGION }}
      CENTAUR_FUNCTION_NAME: ${{ vars.CENTAUR_FUNCTION_NAME }}
      CENTAUR_OIDC_AUDIENCE: ${{ vars.CENTAUR_OIDC_AUDIENCE }}
      CENTAUR_SESSION_BUCKET: ${{ vars.CENTAUR_SESSION_BUCKET }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ needs.resolve.outputs.head_ref }}
      - uses: ./.github/actions/setup-runtime
      - uses: ./.github/actions/turn
        with:
          comment: "true"
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
      - if: failure()
        uses: ./.github/actions/notify-failure
```

Notes on the shape:

- The group string is identical to the one in `centaur-message.yml`, so a comment turn and a chat
  turn on the same thread run one at a time and never push to the branch concurrently. The key is
  the hashed thread key, never the raw thread ID.
- `head_ref` is the pull request head branch, bot-controlled text that reaches `actions/checkout` only as
  an input, never a shell script.
- The comment body is never used in an `if:` or `run:` expression.
- A job skipped by `if:` is not a failure, so cheap rejections do not notify anyone.
- GitHub keeps one pending run per concurrency group and cancels older pending ones. A comment
  whose run is superseded must not be lost; see [Context policy](#context-policy-and-the-prompt).

## Mapping a pull request to its thread

The branch name carries only the 12-hex thread key, a SHA-256 prefix of `bot\0threadId`, which
cannot be reversed. Scheduled prompts (`centaur/<bot>-<prompt>-<run id>`) have no key at all, and
for them the thread is created by `finish` after the pull request exists. The raw thread ID (a
Telegram chat ID, a Slack channel) must not appear in a branch, a pull request body, a comment, a
concurrency group name or a job output (outputs show up in Actions logs).

| Option | How | Verdict |
|---|---|---|
| A. Stored mapping keyed by pull request | `finish` calls a new poster operation `link-pull-request` with `bot`, `threadId` and the pull request URL after it knows both. The poster stores `pull-request:<repo>#<number>` = `{ bot, threadId }` in the state table (with a TTL) | Works for chat-thread and scheduled pull requests; nothing sensitive on GitHub; one lookup |
| B. Metadata in the pull request body | `finish` writes `<!-- centaur: bot=<bot> key=<key> -->` in the body; the workflow reads it | Still needs a key-to-thread index to get the thread ID; the body is editable by anyone with write access; scheduled runs have no key |
| C. Derive from the branch | Parse `<bot>-<key>` from `centaur/...` | The hash cannot be reversed without an index; bot names can contain `-`; fails for scheduled pull requests |
| D. Index the key only | The receiver writes `thread-key:<bot>:<key>` = thread ID at dispatch; the branch gives the key | Covers chat-thread pull requests only; scheduled pull requests still need A |

**Recommendation: A.** One mechanism covers both ways a pull request is born, and everything
sensitive stays in the state table and the poster, matching the existing rule that GitHub sees only
the thread key.

Details of A:

- Operations (see [poster.md](poster.md)): `link-pull-request` (`bot`, `threadId`, `pullRequest`: the
  URL) and `resolve-pull-request` (`repo`, `number`; result `{ bot, threadKey }` for the `resolve`
  job, and `{ bot, threadId }` for `prepare`, which asks again with a `withThreadId` flag so the
  raw ID never becomes a job output).
- The poster accepts a link only when the URL's repository equals `bots/<bot>/repo`, so one
  consumer cannot attach its pull requests to another repo's bot.
- `finish` already runs after `create-pull-request` and knows the thread (for scheduled prompts,
  from `start-thread`). It writes the link in the same step that appends the pull request link to
  the reply. A failed write is a warning, like reaction removal: the pull request still exists,
  comments on it just do not trigger turns.
- The record is refreshed whenever a turn updates the pull request, so a TTL (suggest 90 days
  without activity) never expires an active pull request.
- Pull requests with no record (opened before this feature, or whose link write failed) are skipped silently by `resolve`, with a log line naming only the repository and number.
- A pull request opened by a chat turn is also resolvable without A, through D, but one mechanism
  is simpler than two; D is not recommended.
- A thread's pull requests are not unique: the same branch is reused across the thread's turns, so
  one thread has at most one open pull request; the record is keyed by pull request, so a later
  pull request from a new branch just gets its own record.

`prepare` double-checks the result: the resolved bot must equal `config.bot`, as `chatTurn` already
does for dispatch payloads.

### Which pull requests are handled

`resolve` skips unless all hold: the pull request is open, its head repository equals the base
repository (never a fork), the head branch starts with `centaur/`, and a mapping exists. Forks never
match because the agent only pushes branches to the repository itself.

## Context policy and the prompt

The pull request comment is another source of pending messages for the thread, so the thread's
policy applies unchanged: the latest `/resume` or `/transcript` in the chat thread, else
`context.default`. A `fresh` thread stays fresh.

| Policy | Comment turn sees |
|---|---|
| `fresh` | Pull request title and body, the comments to answer, the diff of the branch against its base |
| `transcript` | The above plus the chat thread's earlier messages (the same history rendering `prepare` uses for chat turns) |
| `resume` | The comments to answer only, in the restored session; if no session exists, as `transcript` |

Chat messages that have not yet been processed stay pending: a comment turn never advances the
chat last-processed marker and never clears chat reactions, because it consumes no chat messages.
For `resume`, the restored session is saved back under the thread's key after the turn, so a later
chat turn continues from it. Because the concurrency group serializes the two kinds of turn, they
never save over each other.

**Not losing comments to concurrency.** The turn does not answer only the triggering event. It lists
every human comment, review and inline comment on the pull request newer than the agent's most
recent marked comment (see [Loop prevention](#loop-prevention)) or, if there is none, newer than the
pull request, and answers them together. If a pending run was cancelled by GitHub, the next one
picks its comment up. If nothing is newer than the last marked comment, the turn skips.

Inline comments carry context the prompt must include: file path, line, the diff hunk, the thread
they reply into, and the review state. The script, not the agent, fetches these with `gh api` and
writes them to `.centaur-turn/prompt.md`.

## Delivering the result

| What | How |
|---|---|
| The agent's `reply` | Posted as a pull request comment by a new `finish` mode, authored by `github-actions[bot]` through `GITHUB_TOKEN`. When the turn answers one inline thread it replies in that thread (`POST /repos/{r}/pulls/{n}/comments/{id}/replies`); otherwise it is a conversation comment. Every comment carries the hidden marker |
| Follow-up commits | Pushed to the pull request branch with `git push`; **not** through `create-pull-request` |
| Chat | A short note in the originating thread (see below) |
| `ignore: true` | Nothing is posted to the pull request unless commits were pushed |

Why `create-pull-request` is not used for revisions: it creates or resets its own branch from the
checked-out base and opens a pull request when none exists. A revision turn already has the branch
checked out at its head, with the pull request open; a plain commit and push adds to the pull
request without rewriting history. The comment turn therefore skips `pr-details` and
`create-pull-request`, and a new `push` step commits any working tree changes (commit message from
the agent's `pr_title`, falling back to `Address review comments`) and pushes the head branch.
`pr_title` and `pr_body` are not used; the schema stays unchanged, so none of the three places in
AGENTS.md for a new structured-output field need touching. The agent's `reply` is what is posted.

Pushes with `GITHUB_TOKEN` do not trigger CI. The same limitation applies to the pull requests
opened today; a consumer that needs CI on agent pushes must use a token that can trigger workflows,
for which the existing PAT model has a GitHub App upgrade path ([plan.md](plan.md)). Do not solve
that here.

**Chat note.** After the pull request comment is posted, `finish` posts to the originating thread:
`Replied on <pull request URL>` plus `and pushed N commit(s)` when applicable. The note holds no
comment content: chat threads can be group chats, and the comment text and the agent's reply are
already on the pull request. The thread is the one the poster resolved. If the chat post fails it is
a warning; the pull request reply is the source of truth.

Failure: `notify-failure` posts its generic notice (with the run URL) to the pull request as a
marked comment, and to the thread, so the commenter is not left waiting.

## Who may trigger a turn

The agent runs with repository write access and secrets, so this is the main security decision. The
chat side is gated by the admin's approved users and chats ([plan.md](plan.md#security)); those IDs
are platform user IDs and have no link to GitHub logins.

| Option | Strength | Weakness |
|---|---|---|
| Repository permission: `write`, `maintain` or `admin` on the repo (checked by API for the commenter) | Matches who can already push to the branch; no new admin task; no mapping | A repo admin who is not the bot's admin can drive the agent. Not tied to the bot's approvals |
| `author_association` in `OWNER`, `MEMBER`, `COLLABORATOR` | Needs no API call; present in the payload | Includes read-only collaborators and any org member on a public repo; coarser than permission |
| Bot's admin approvals (a mapping from GitHub login to approved users) | One approval model | No mapping exists; needs new CLI commands, SSM entries and a verification step proving who owns which login |
| Both (repo write and an approved GitHub login) | Strictest | Adds the unbuilt mapping and a second approval to every collaborator |

**Recommendation: repository permission `write` or higher**, checked by `resolve` with
`GET /repos/{r}/collaborators/{login}/permission` and the workflow's `GITHUB_TOKEN`. Rationale: the
pull request is already a human-review surface, anyone with write access can push to or merge the
branch anyway, and the thing being protected (an agent turn driven by arbitrary text) is no more
dangerous than what a writer can already do. The bot's chat admin keeps control of chat access
only. A later hardening, if wanted, is an `approved-github-users` list in SSM checked in addition
(the "both" row), without changing the workflow shape.

The check is done by the script in the centaur checkout, and fails closed: an API error skips the
turn.

## Loop prevention

A turn posts a comment and may push; those must never start another turn.

| Defense | What it stops | Limit |
|---|---|---|
| `github.event.sender.type != 'Bot'` in the `resolve` job's `if:` | Comments by GitHub Apps and `github-actions[bot]` | Does not stop a PAT-authored comment, which shows as a human user |
| Comments and pushes made with `GITHUB_TOKEN` do not trigger workflows | The agent's own replies and commits | Disappears if the workflow is changed to use a PAT or an App token |
| Hidden marker `<!-- centaur:reply -->` in every comment the agent posts; `resolve` skips events whose comment body (read by the script) contains it | PAT-authored agent comments; a manual replay of an agent comment | A human quoting the marker suppresses their own comment; harmless |
| Compare `sender.login` with the login behind the token the workflow posts with | Self-authored comments under any token | Needs the login; `GET /user` with the token (or `github-actions[bot]`) provides it |
| Per-pull-request cap on consecutive agent turns without a human comment between | Runaway cases the other layers miss | Extra state; only needed if the layers above are removed |

**Recommendation:** the `sender.type` filter, the marker, and the permission check (which already
rejects a bot account without write access), plus the `GITHUB_TOKEN` behavior as a free backstop.
The marker is also what bounds "comments since the agent's last reply", so it does double duty.
No per-pull-request cap in the first version.

## Security notes

- **Comment text is untrusted input.** Even from a collaborator it may carry pasted content, and
  anything it quotes or links (a file in the diff, a web page) can contain instructions. Prompt
  injection cannot be eliminated; the mitigations are structural. The agent's tools are the
  consumer's `allowed_tools`; its token is the job's `GITHUB_TOKEN` with `contents` and
  `pull-requests` write only; a revision lands as a commit on a branch a human reviews and merges,
  and the agent cannot merge. The prompt delimits the comments as quoted data and says to treat
  them as requests to revise the change, not as instructions overriding the persona.
- **Forks.** `issue_comment` on a fork's pull request runs with secrets, and the agent would check
  out and read code the commenter's fork controls. `resolve` therefore requires the head repository
  to equal the base repository and the branch to start with `centaur/`, in a script that does not
  evaluate anything from the pull request. `pull_request_review` events from forks have a read-only
  token and no secrets, so they would fail anyway; the same check skips them early.
- **No expression injection.** `github.event.comment.body`, `review.body`, the head ref and the
  pull request title never appear in `run:` scripts or `env:`. The scripts read the event file and
  fetch content through `gh api`. The head ref reaches `actions/checkout` only as an input.
- **Keep content out of logs.** As for chat messages ([workflows.md](workflows.md#keeping-content-out-of-github)):
  comment text goes to `.centaur-turn/prompt.md`, not step inputs, `env:` or logs; `show_full_output`
  stays off; no artifacts; script errors report types and IDs, not bodies. The comment is already
  on GitHub, but copying it into logs widens its audience and its retention. Raw thread IDs are
  never printed: `prepare` masks the thread ID it resolves.
- **Trust in the workflow file.** For `pull_request_review` the workflow file comes from the pull
  request. Anyone who can push to the branch can change it. Writers can already add workflows to a
  branch, so this is not a new capability of the feature, but it is the reason the permission and
  fork checks live in the centaur action, and the consumer's branch protection should require
  review for workflow changes.
- **Cost.** Every comment from a writer starts an agent turn. `max_turns` and `max_budget_usd` from
  `.centaur.yml` still bound each turn; the `timeout-minutes` bounds the job.

## Implementation plan

Each step is independently reviewable and could become a TODO item.

1. **Poster operations** `link-pull-request` and `resolve-pull-request`: state-table record keyed by
   repository and number, repo check against `bots/<bot>/repo`, TTL, tests in `test/` with
   dynamodb-local, `docs/poster.md`.
2. **`finish` links the pull request** to the thread it replied in (chat turns and scheduled
   prompts), as a warning on failure. Unit tests with a fake poster.
3. **`resolve-pr-comment` action and `resolve` command** in `src/workflows/`: parse the event file,
   filter (bot, fork, branch, state), check permission, apply the marker check, call
   `resolve-pull-request`, write outputs (`skip`, `bot`, `thread_key`, `head_ref`). Tests with a
   fake GitHub client.
4. **Comment mode in `prepare`**: a pull request comment source next to `chatTurn`, producing the
   prompt (comments since the last marked comment, inline context, diff, history by policy) and the
   `TurnState`. No marker or reaction handling.
5. **Comment mode in `finish`**: post the reply (conversation or inline reply, with the marker),
   push commits, post the chat note, refresh the record. A `push` command replaces
   `create-pull-request` in this mode.
6. **Wire the `turn` action** with a `comment` input (skipping `pr-details` and
   `create-pull-request`, adding `push`) and the failure notice to the pull request.
7. **Example and docs**: `.github/workflows/centaur-pr-comment.yml` in this repo (the test
   consumer), and `docs/workflows.md`, `docs/onboarding.md`, `docs/plan.md` updated to say it exists.
8. **Verify event coverage** on a real pull request: single inline comment, batched review,
   reply in an inline thread, conversation comment, fork pull request, bot comment; settle the
   `pull_request_review_comment` question.
9. **Reference consumer** in `blevinstein/garden` and the end-to-end check (a review comment on a
   `weekly-tasks` pull request gets an in-thread reply and a pushed fix).

## Decisions

The maintainer accepted every recommendation below.

1. **Authorization.** Repository `write` permission only, versus also requiring an approved GitHub
   login in SSM. Recommendation: repository write permission only.
2. **PR-to-thread mapping.** A stored record written by `finish` via the poster, versus encoding
   metadata in the pull request body or branch. Recommendation: the stored record keyed by
   repository and pull request number.
3. **Events.** `issue_comment` plus `pull_request_review` only, versus also
   `pull_request_review_comment`. Recommendation: the first two, adding the third only if step 8
   shows inline replies do not fire `pull_request_review`.
4. **Delivery of revisions.** Push commits to the pull request branch with plain `git`, versus
   running `create-pull-request` again. Recommendation: plain push.
5. **Chat note content.** A fixed note with the pull request link and commit count, versus
   including the agent's reply text. Recommendation: fixed note, no content.
6. **Loop prevention.** The `sender.type` filter, a hidden marker and the permission check, versus
   also a per-pull-request turn cap. Recommendation: the first three; no cap yet.
7. **CI on agent pushes.** Accept that `GITHUB_TOKEN` pushes do not trigger CI, versus requiring a
   token that triggers workflows (a GitHub App). Recommendation: accept for now, same as the
   pull requests opened today.
8. **Record lifetime.** TTL of the stored mapping (suggest 90 days since last activity, refreshed on
   each turn), and whether comments on older pull requests are skipped silently or answered with a
   notice. Recommendation: 90-day TTL, skip silently.
9. **Closed and merged pull requests.** Skip, versus answer a comment on a merged pull request.
   Recommendation: skip closed pull requests.
10. **Existing pull requests** opened before the feature have no record. Recommendation: no
    backfill; they are skipped.
