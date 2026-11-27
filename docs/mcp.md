# Additional MCP servers (design)

Status: implemented and verified against the remote GitHub MCP server, using the Actions token as the
bearer. `prepare` writes the config and the turn fails on a missing secret. `register` enforces the
operator policy below. This describes how a consumer repo adds MCP servers to a turn through
the config ([config.md](config.md), [workflows.md](workflows.md#agent-turn)). The agent has no
MCP servers beyond the ones `claude-code-action` provides itself.

## What `claude-code-action` accepts

From the action's `docs/configuration.md` and `docs/usage.md`:

- MCP servers are passed as `--mcp-config <json string or file path>` inside `claude_args`. The
  `mcp_config` input is deprecated. The flag may repeat; the configs are merged, and a custom
  server with the same name as a built-in one overrides it.
- The file is the standard `{"mcpServers": {"<name>": {...}}}` shape: stdio servers
  (`command`, `args`, `env`, optional `"type": "stdio"`) and remote servers (`type`, `url`,
  `headers`).
- Tools are not allowed automatically. Each must be named in `--allowedTools` as
  `mcp__<server>__<tool>`.
- The action documents secrets as values written into the config file from `${{ secrets.X }}` by a
  workflow step.

Centaur already assembles `claude_args` in `buildClaudeArgs` (`src/workflows/prepare.ts`) and writes
per-turn files under `.centaur-turn/`, so the config file fits the existing flow: `prepare` writes
`.centaur-turn/mcp.json` and appends `--mcp-config .centaur-turn/mcp.json` to `claude_args`.

## Schema

```yaml
mcp_servers:
  linear:                        # the name becomes the tool prefix mcp__linear__*
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: { secret: LINEAR_API_KEY, prefix: "Bearer " }
  docs-search:
    command: npx
    args: ["-y", "@example/docs-mcp@1.4.2"]
    env:
      INDEX_URL: https://docs.example.com/index   # plain, non-secret value
      API_KEY: { secret: DOCS_API_KEY }           # by name, never inline
allowed_tools:
  - Read
  - mcp__linear__*
  - mcp__docs-search__search
```

Each server is exactly one of two shapes:

| Shape | Fields |
|---|---|
| Remote | `url` (https), optional `headers` |
| Local (stdio) | `command`, optional `args` (strings), optional `env` |

Values in `env` and `headers` are either a plain string or `{ secret: NAME, prefix?: string }`.
`NAME` matches `[A-Z][A-Z0-9_]*`. Nothing else is accepted (strict objects, as elsewhere).

In `src/config/schema.ts` this is a `z.record(serverName, z.union([remoteServer, localServer]))`
under `mcp_servers`, defaulting to `{}`. The two shapes are `z.strictObject`s, so a server giving
both `url` and `command`, or neither, fails. `serverName` is the shared lowercase-name check, further refined to
reject `__` (it is the separator in tool names) and names that start with `github` (reserved for the
action's built-in servers, which a same-named entry would silently replace). `secretRef` is
`z.strictObject({ secret: z.string().regex(...), prefix: z.string().optional() })`.

## Validation

Everything that can be checked from the file alone is checked by `parseCentaurConfig`, so
`centaur config check` and `register` report it with dotted paths (`mcp_servers.linear.url`):

- the shape rules above, and `https:` for `url`;
- cross-field: every `mcp__<name>__...` entry in `allowed_tools` names a server defined in
  `mcp_servers` (a typo would otherwise silently allow nothing);
- cross-field: every server has at least one `mcp__<name>` entry in `allowed_tools`, since a
  configured but unallowed server only costs start-up time and tool-list tokens;
- the operator policy below: `centaur config check` checks the local copy of the file, while `register` and
  `prepare` check the default branch's copy.

Checked only at turn time, in `prepare`: every `{secret: NAME}` has a non-empty environment variable
`NAME`. A missing one fails the turn with the name and the caller-workflow line that supplies it,
rather than starting a server that fails to authenticate.

## Secrets

Composite actions cannot read `secrets.*` themselves; only the caller workflow can. `turn` already
takes the two model keys as inputs for this reason, but arbitrary names defined in the config
cannot be declared as inputs in advance. Options:

| Option | Mechanism | Assessment |
|---|---|---|
| A. Fixed inputs | `mcp_secret_1 ... mcp_secret_N` | Arbitrary cap, names unrelated to the config. Rejected. |
| B. One JSON input | Caller passes `mcp_secrets: ${{ toJSON(secrets) }}` | Hands every repo secret to the step, including ones no server asked for. A config edit could then read any of them. Rejected. |
| C. Caller `env:` | Caller sets `env: { LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }} }` on the `turn` step; `prepare` reads `process.env[NAME]` | The caller lists exactly the secrets it is willing to expose; the config can only reference those. |
| D. Caller JSON of named secrets | `mcp_secrets: ${{ toJSON({LINEAR_API_KEY: secrets.LINEAR_API_KEY}) }}` | Same exposure as C with an extra parse step and an input to document. |

Recommendation: C. The caller workflow is the consent boundary: a secret reaches the turn only when
the consumer wrote a line naming it, and a config edit cannot widen that set. Env set on the
`uses:` step is inherited by the composite action's steps.

`prepare` must not write the secret into `mcp.json`. It writes the config with Claude Code's
`${NAME}` expansion (supported in `env`, `args`, `url` and `headers` of MCP config), so the file holds
references and the value stays in the process environment; the MCP client expands it when it starts
the server. `prefix` becomes literal text around the reference (`"Bearer ${LINEAR_API_KEY}"`).
`${NAME}` expansion in the `headers` of a file passed with `--mcp-config` is verified against a real
remote server, so the file never holds the value.

Residual exposure: the secret is in the environment of the agent process, so any allowed `Bash` tool
can read it. Consumers who list secrets for a server should keep `Bash` out of `allowed_tools`, or
accept that the agent can read them. This is the same trust placed in the existing API keys.

## Generated config and `claude_args`

```json
{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp",
                "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" } },
    "docs-search": { "type": "stdio", "command": "npx", "args": ["-y", "@example/docs-mcp@1.4.2"],
                     "env": { "INDEX_URL": "https://docs.example.com/index", "API_KEY": "${DOCS_API_KEY}" } }
  }
}
```

`prepare` writes this beside `prompt.md` and adds `--mcp-config .centaur-turn/mcp.json` to
`claude_args` only when `mcp_servers` is non-empty, so repos without servers are unchanged. The
remote `type` is `http` (streamable HTTP); `sse` is not supported. The mapping from config to JSON
is a pure function in `src/workflows/`, unit-tested without the filesystem.

## Naming tools in `allowed_tools`

Claude Code names a tool `mcp__<server>__<tool>`. `allowed_tools` stays the single place that
grants tools, and servers are not allowed automatically: configuring a server and permitting its
tools are separate decisions, so a repo can run a read-only subset of a server that also exposes
write tools.

- Whole server: `mcp__linear__*` (the bare `mcp__linear` form is equivalent in Claude Code).
- Per tool: `mcp__linear__get_issue,mcp__linear__list_issues`. Recommended for servers with write
  or delete tools.

`buildClaudeArgs` only adds `--mcp-config`; entries pass through `--allowedTools` as today. The
existing `Read(./.centaur-turn/**)` rule still applies; `mcp.json` is in that directory but holds no
secrets.

## Trust model

A server entry is code execution (`command`) or a data and credential channel (`url`, `headers`)
with the turn's secrets. The question is who can introduce one.

Which config a turn reads: `prepare` reads the config from the workspace, which the caller's
`actions/checkout` populates. The caller workflows run on `repository_dispatch` and `schedule`,
which GitHub only runs from the default branch, and check out its head. So turns read config from
the default branch, never from a pull request branch. The agent's own pull requests
(`centaur/<bot>-<thread>`) can edit the config, but the edit has no effect until a human merges
it. `register` also runs on pushes to the default branch.

Consequences:

- Anyone who can merge to the default branch can add a server. This is the same set that can already
  edit the caller workflow and `allowed_tools`, so servers do not widen who is trusted; they make
  what a merge grants less obvious in a diff.
- A bot-authored pull request that adds a server is the realistic attack: a prompt-injected agent
  proposes `mcp_servers` plus `allowed_tools` entries that exfiltrate secrets. Review of
  config changes in agent pull requests is the control, which is why the mitigations below
  make the dangerous shapes fail validation instead of relying on a reviewer to notice them.
- Another workflow (a manual `workflow_dispatch` on a feature branch) can run a turn from a branch
  config. That is the maintainer's explicit act and needs no extra handling.
- A checked-out repo may contain its own `.mcp.json`. The action does not pick it up as trusted
  config today; keep this out of scope and do not rely on it.

Mitigations, in order of recommendation:

1. Secrets only through the caller `env:` (above). A merged config cannot reach a secret the caller
   did not list.
2. A Cedar policy: the deployer's global file plus the repo's `.centaur/mcp-policy.cedar`, the latter always read from the default branch
   (see [Operator policy](#operator-policy)). Config that violates it fails registration and every
   turn. A pull request that edits the policy has no effect until it is merged, so protect the file
   with required review.
3. Remote servers only by default: reject `command` servers unless the policy permits specific
   commands. Remote servers cannot run code on the runner.
4. Pinned packages: when `command` is allowed, require `npx`/`uvx` arguments to carry an exact
   registry version (`pkg@1.4.2`) or a git URL at a full 40-hex commit SHA, and reject `@latest` or
   unpinned names, so a registry publish cannot change what runs. A commit SHA pins the content
   itself; the repo policy still chooses which commands and sources are allowed (see
   [Operator policy](#operator-policy)). Container images by digest if `docker` is ever allowed.
5. Surface changes: `register` (which runs on merge to the default branch) lists the configured
   servers in its job summary so additions are visible after the fact.

## Operator policy

Every `mcp_servers` entry is authorized against a [Cedar](https://www.cedarpolicy.com/) policy set
made of two layers:

- the **global** layer, `infra/mcp-policy.cedar` in the deployer's repo, bundled into the Lambda zip
  by `scripts/deploy.sh` and applying to every registered repo; an absent file means no global layer;
- the **repo** layer, `.centaur/mcp-policy.cedar` in the consumer repo, at a fixed path. The path is
  not configurable: a config field pointing at the file could be edited in the same pull request
  that adds the server.

The layers are merged into one policy set (policy ids `global.N` and `repo.N`), so the usual Cedar
rules compose them: a server is allowed when some `permit` in either layer matches and no `forbid`
in either layer does. A global `forbid` therefore cannot be lifted by a repo. Write allowlist
ceilings as `forbid(...) unless { ... }`. A global `permit` is a default for every repo, and with
one a repo needs no policy file of its own; with no global permit the repo layer must permit each
server. With neither layer present, every server is denied. There are no per-bot layers.

This repo's global file forbids plain-HTTP remote servers and unpinned local packages, and permits
nothing, so each repo still has to permit its own servers.

**Default branch only.** Both enforcement points fetch the repo layer through the GitHub contents API at
the repository's default branch (`GET /repos/{owner}/{repo}/contents/.centaur/mcp-policy.cedar?ref=<default branch>`,
with the default branch from `GET /repos/{owner}/{repo}`). They never read the workspace copy,
because a turn can run on another branch (`workflow_dispatch`) and the agent can edit files in the
checkout. A pull request that changes the policy therefore has no effect until it is merged.

**Where it runs.** On the runner, in one shared check, before any other poster call:

- `register` (the `register` action), so registration fails early;
- `prepare`, on every turn mode including pull request comment turns, so a policy change takes
  effect on the next turn without re-registering.

The check reads the global layer through the poster's `get-mcp-policy` operation (it names the config's bot, which must not be bound to another repo),
which returns the bundled file's text or `null` ([poster.md](poster.md)); it is the only poster call
that precedes the check. The poster is invoked with IAM-authorized AWS credentials, as for `post` and
`read`, so the operation carries no OIDC token. The workflows need `contents: read` on the
`GITHUB_TOKEN` (the register action passes `github.token`, as the turn action already does).

**Fail closed.** If `mcp_servers` is non-empty, the check fails, naming each server
(`mcp_servers.ghmcp: not permitted by any policy`), when neither layer exists (no bundled global
file and a 404 for the repo file), the poster call fails, the repo file or repository cannot be
fetched (any other error), either policy does not parse, or evaluation errors. Messages name the
layer that failed (`cannot read the global operator policy: ...`, `operator policy is invalid: global: ...`)
or the policy that denied (`forbidden by policy global.0`). A config without `mcp_servers` never
fetches a policy.

**Model.** Each server is a request: principal `Bot::"<bot>"`, action `Action::"UseServer"`, resource
`McpServer::"<name>"`. The resource attributes are always all present:

| Attribute | Remote server | Local (stdio) server |
|---|---|---|
| `transport` | `"remote"` | `"stdio"` |
| `host`, `url` | URL hostname and full URL | `""` |
| `command`, `args` (set of strings) | `""`, empty | the command and its arguments |
| `pinned` (bool) | `false` | for `npx` and `uvx` only: the launched package is an exact registry version, such as `pkg@1.4.2` or `pkg==1.4.2` (a bare package name, optionally scoped or with `[extras]`, never a URL or path), or a git URL at a full 40-hex commit SHA (see below). The package is the `--from` value for `uvx` (given once), every `-p`/`--package` value for `npx`, else the first positional argument after skipping the launcher's flags (and their values). Every uvx `--with` value must be pinned too, and `--python` must be a plain version. With `uvx --from` or `npx -p`, the command to run must be a plain name that is not a shell, interpreter or other generic runner. `pinned` is `false` for any flag that can redirect resolution (index, registry, config, requirements, constraint, override, editable, directory flags), an unknown flag, a missing value, `npx -c`, any other command, or when no package is found. Resolution still depends on the runner's environment (`.npmrc`, `uv.toml`), which the check cannot see |

A server is allowed when some `permit` matches and no `forbid` does. Policy templates are not
supported.

**Pinned git sources.** The git forms that count as `pinned` are
`git+https://<host>/<path>@<sha>` (optionally followed by `#egg=<name>` or `#subdirectory=<dir>`),
`git+https://<host>/<path>#<sha>` and `github:<owner>/<repo>#<sha>`, where `<sha>` is 40 hex digits
in either case. These are not pinned: a short or 41-digit SHA, a branch or tag, no ref, `git+ssh://`
or plain `git+http://`, credentials in the URL, and anything after the SHA (`~1`, `^`, `:path`).
A commit SHA pins the content, but `pinned` says nothing about the host or repository, so the repo
policy names the source it permits:

```cedar
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "stdio" && resource.command == "uvx" && resource.pinned &&
    resource.args == ["--from", "git+https://github.com/example-org/example-mcp-server@0123456789abcdef0123456789abcdef01234567", "example-entrypoint"]
  };
```

The permit fixes the whole argument list, so it matches this command, source and entrypoint only: a
different first package, an extra argument or another entrypoint does not match. A new commit SHA
is a reviewed edit of the permit.

This repo's own policy (`apps/centaur-test/.centaur/mcp-policy.cedar`) permits only the read-only endpoints of the remote GitHub MCP server, and only
with a decision by the admin or an approver (the maintainer's own repo uses approval):

```cedar
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "remote" &&
    resource.host == "api.githubcopilot.com" &&
    (resource.url == "https://api.githubcopilot.com/mcp/readonly" ||
     resource.url like "https://api.githubcopilot.com/mcp/x/*/readonly") &&
    context.approved
  };
```

The server enforces the `/readonly` path, so the agent cannot reach a write tool even if
`allowed_tools` names one; matching the exact URL pins that. A bare `https://api.githubcopilot.com/mcp/`
is denied. Other examples:

```cedar
permit(principal == Bot::"garden", action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.command == "npx" && resource.pinned };

forbid(principal, action == Action::"UseServer", resource) when { resource.host like "*.untrusted.example" };
```

**Allow any pinned local server.** The global file permits nothing by itself, so a repo needs a
permit in its own `.centaur/mcp-policy.cedar` to enable a server: one of these, or a narrower permit
naming a command or an exact argument. With a decision by the admin or an approver (the global
`context.approved` default is under Approval by the admin, below):

```cedar
permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.pinned && context.approved };
```

Each server definition is approved once; editing it, including a new commit SHA, asks again. Without
a human decision:

```cedar
permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.pinned };
```

This lets any pinned third-party code in the repo's reviewed config run with the job's secrets in
its environment, so prefer the first variant.

**Protect the file.** Require review on `.centaur/mcp-policy.cedar` with a `CODEOWNERS` entry or a
repository ruleset, since anyone who can merge a change to it can permit any server.

**Protect the global file.** It ships with a deploy, so changes need the deployer's normal review.
The global layer is the only part a repo owner cannot change.

Check a config and its policy locally with `centaur config check [path]`. That command reads the
local `.centaur/mcp-policy.cedar` next to the config, which is convenient for editing but is not what
enforcement uses. Add `--global-policy infra/mcp-policy.cedar` to check against the global layer too.

**Approval by the admin.** A policy that says `permit(...) when { context.approved }` allows a server
only once the bot's admin has approved that server. Without a `context.approved` condition a permit
allows the server outright, and a `forbid` always wins: approval never lifts a ceiling. A typical
global default lets any server the ceiling allows through once the admin approves it:

```cedar
permit(principal, action == Action::"UseServer", resource) when { context.approved };
```

`centaur config check`, `register` and `prepare` accept such a server and print a notice naming its
approval key, `<name>:<fingerprint>`. The outcome table, the fingerprint and the design are in
[mcp-approval.md](mcp-approval.md).

What happens at a turn:

- The first turn that uses an unapproved server sends the admin, and each [approver](approvers.md), a direct message with the bot,
  repository, server and a one-line summary (transport, host or command, secret names, allowed tools;
  never values or message text). The turn runs without the server, and the agent is told it is
  awaiting approval; if it cannot do the request without it, it can suspend the turn, which resumes
  after the decision ([workflows.md](workflows.md#approval-required-mcp-servers)).
- The admin or an approver reacts 👍 to approve or 👎 to deny, or sends `/approve <id>` or `/deny <id>` where the
  platform supports it. The request expires after 7 days.
- An approval persists for that bot and server definition until revoked. A denial lasts 7 days and
  the bot does not ask again meanwhile.
- `centaur mcp approvals <bot>` lists the approvals and `centaur mcp revoke <bot> <server>` removes them
  ([cli.md](cli.md#centaur-mcp-approvals-bot)); the server is asked about again the next time a turn
  uses it.
- `centaur mcp approve <bot> <server> --yes` approves the definition on the default branch ahead of
  the first turn, so no request is raised ([cli.md](cli.md#centaur-mcp-approve-bot-server---yes)).
- Editing the server's definition (its URL, command, arguments, env or header entries, or the
  `allowed_tools` entries naming it) asks again, because the approval belongs to the definition.
  Removing the `when { context.approved }` permit makes the policy deny the server, and the turn
  fails like for any denied server.

### Tool-call policy

`UseServer` is decided once, in `prepare`. To restrict individual tool calls by their arguments, write
`CallTool` policies in the same files. A call is a request with principal `Bot::"<bot>"`, action
`Action::"CallTool"`, resource `McpTool::"<server>/<tool>"` (attributes `server` and `name`) and
`context.args`, the call's arguments. Every call is permitted unless a `forbid` matches, so `CallTool`
policies only restrict and never need a `permit`. Policies for other actions never apply to a call.

**Write an allowlist.** Name the tool, then list what may pass:

```cedar
// delete_issue only for these issues
forbid(principal, action == Action::"CallTool", resource)
  when { resource.server == "linear" && resource.name == "delete_issue" }
  unless { context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id) };
```

A call that lacks the argument, or sends another value or type, is refused. Do not write the denylist
form (`when { context.args.team == "secret" }`): another parameter name, spelling or encoding the tool
also honors gets past it. Always guard an argument with `has`; a policy that errors on a missing
argument refuses the call, and the validator rejects an unguarded read.

Pitfalls the allowlist form does not cover:

- **Sibling parameters.** If the tool also takes `ids` and honors both, `id` alone proves nothing.
  Cedar cannot iterate argument names, so name each sibling and refuse it inside the `unless`. The
  validator treats `has` on an argument as always false, so a bare `when { ... && context.args has ids }`
  is rejected as an impossible policy; negate it in the allowlist instead:

  ```cedar
  forbid(principal, action == Action::"CallTool", resource)
    when { resource.server == "linear" && resource.name == "delete_issue" }
    unless {
      !(context.args has ids) && context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id)
    };
  ```

- **Wildcards.** With `mcp__linear__*` in `allowed_tools`, a tool the server adds later is allowed.
  Prefer one `allowed_tools` entry per tool. For a server that must stay on a wildcard, allowlist by
  tool name so a new tool is refused until the policy names it:

  ```cedar
  forbid(principal, action == Action::"CallTool", resource)
    when { resource.server == "linear" }
    unless { ["get_issue", "list_issues"].contains(resource.name) };
  ```

- **Literals.** Server and tool names are compared as exact strings (`"Linear"` is not `"linear"`,
  `"delete_issues"` is not `"delete_issue"`), and a `forbid` on a name that never occurs restricts
  nothing. Policy conditions are linted for that (below).
- **Argument values.** `null` arguments are dropped and non-integer numbers become strings, because
  Cedar contexts hold neither. A tool that reads a value from somewhere other than its arguments
  (an environment variable, a default) is not constrained by them.

**Checks at authoring time.** Both layers are validated against a schema that declares `McpServer`,
`McpTool`, `UseServer` and `CallTool`. A mistyped action (`Action::"CallTools"`) or attribute
(`resource.nmae`), an unguarded `context.args` read, or an impossible policy fails `register`,
`prepare` and `centaur config check`: errors and warnings alike, because a policy that matches nothing
restricts nothing. A forbid must name its action, since `forbid(principal, action, resource)` that
reads `resource.host` no longer type-checks for `McpTool`: write `action == Action::"UseServer"`.
The repo layer's `resource.server`, `resource.name` and `McpTool::"server/tool"` string literals are
also compared with `mcp_servers`, `allowed_tools` and, when `chat_tools.scope` is `chat`, the chat
server: a server that is not configured or a tool that is not in `allowed_tools` fails; a tool
covered only by a wildcard entry is a warning. The global layer is not linted, since it names servers
other repos use.

**Try a call.** `centaur policy check-call --server linear --tool delete_issue --args '{"id":"ENG-9"}'`
evaluates the local `.centaur/mcp-policy.cedar` next to the config (`--global-policy` adds the global
layer, `--root` a sub-folder) and prints `allowed` or `refused: forbidden by policy repo.1`
([cli.md](cli.md)).

**Enforcement.** Whenever `mcp_servers` is non-empty, `prepare` saves the merged layers and the bot
name in the turn state directory, outside the workspace, writes a Claude Code settings file there with
a `PreToolUse` hook on `mcp__.*`, and passes it with `--settings` and `--setting-sources user`. The
hook runs `centaur-workflow tool-gate` with the call on stdin and a 15 second timeout
(`toolGateSettings`, `src/workflows/tool-gate.ts`). These behaviors were confirmed on 2026-11-26 against
`claude-code-action@v1` with Claude Code 2.1.332:

- Claude Code blocks a call only when a hook exits with code 2 (or prints a clean JSON deny). Exit 1, a
  crash, a missing script, a timeout, or stray stdout before a JSON deny all let the call proceed.
  The hook entry therefore sets `onFailure: "block"` (Claude Code 2.1.295 or later), which blocks on a
  missing script, a crash and a timeout, and the command is a shell wrapper that maps every non-zero
  exit, and any output on stdout, to exit 2.
- A refusal is exit 2 with the reason on stderr, which appears in the transcript. An allow is exit 0
  with nothing on stdout, which leaves the decision to `allowed_tools`; a hook never grants a tool that
  `allowed_tools` does not list.
- A crash, unreadable policy, malformed input, unparseable tool name or evaluation error is a refusal.
  The posture is closed once a deployment uses the feature.
- `--setting-sources user` keeps the agent from switching the gate off: with the default sources, an
  agent that wrote `.claude/settings.local.json` with `disableAllHooks` mid-run disabled the hook. A
  committed settings file with `disableAllHooks` does not disable a `--settings` hook either way. The
  flag means a chat or scheduled turn with `mcp_servers` no longer reads the workspace's
  `.claude/settings*.json`, project skills or project rules; what `prepare` copies into
  `$HOME/.claude` (repository instructions, consumer skills) still loads, as on a comment turn.
- Server names reach the hook exactly (`mcp__probe-srv__echo_id`), and a server whose name holds a dot
  is never connected. Config validation already limits server names to `[a-z0-9_-]` without `__`.

**Audit.** The turn action's "Audit MCP tool calls" step runs right after the agent, before anything is
pushed or posted. It re-evaluates every `mcp__*` `tool_use` in the execution file against the saved
policy and fails the turn, which sends the usual failure notice, if any call would have been refused.
It is the backstop for a gate that did not run, was disabled or failed open; it cannot prevent a call.

**What remains trusted.** The gate is not isolated from everything the agent can run:

- The saved policy and settings sit in the turn state directory, which the agent's file tools cannot
  reach. A `Bash` tool, when `allowed_tools` includes it, can write there, and can write the user-scope
  files under `$HOME/.claude` (`settings.json`), which `--setting-sources user` still loads. Whether a
  user-scope `disableAllHooks` disables a `--settings` hook was not probed, so do not assume it does
  not. The audit reads the same saved policy, so it catches a disabled hook but not a rewritten policy.
- Other routes to the same capability, such as `Bash` with `curl` or `gh` and secrets in the
  environment, are outside MCP policy. Keep `Bash` out of `allowed_tools` for a bot whose policy
  matters.
- With no `mcp_servers` there is no gate, even for the chat server.

Design notes: [proposals/mcp-tool-policy.md](proposals/mcp-tool-policy.md).

## Permit cookbook

There is no runtime allowlist ([mcp-allowlist.md](mcp-allowlist.md)): a generalized allow is a
reviewed `permit` in the repo's `.centaur/mcp-policy.cedar` (or, for every repo, the global file).
Each recipe below has two forms. The plain permit allows a matching server outright. The
`context.approved` form allows it only after the admin or an approver confirms that exact definition
([Approval by the admin](#operator-policy)), so editing the server asks again. The `forbid` ceiling
at the end beats every recipe.

Replace the example names. A permit matches nothing it does not name, and a server the global
ceiling forbids stays denied whatever is permitted here.

### A remote server by exact URL

Use it when a repo needs one specific endpoint.

```cedar
// cookbook: remote-url
permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "remote" && resource.url == "https://mcp.example.com/mcp" };
```

```cedar
// cookbook: remote-url-approved
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "remote" && resource.url == "https://mcp.example.com/mcp" &&
    context.approved
  };
```

Security: the narrowest remote permit. A different path, query or scheme does not match, and the
headers (so the secrets sent) are not part of the match: the plain form lets a config change which
secret goes to this URL, which the approved form asks about again.

### A remote server by host

Use it when a vendor serves several endpoints under one host and each repo should pick its own.

```cedar
// cookbook: remote-host
permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "remote" && resource.host == "mcp.example.com" };
```

```cedar
// cookbook: remote-host-approved
permit(principal, action == Action::"UseServer", resource)
  when { resource.transport == "remote" && resource.host == "mcp.example.com" && context.approved };
```

Security: `host` is the hostname only. A host permit does not bound the path (so a read-only and a
write endpoint on the host are both allowed; pin the URL as above when the path carries the
privilege, as for the GitHub `/readonly` endpoint), the port (it is not part of `host`), or the
tools the server exposes later, since a server can add tools without any change to the config. Use
`like` for a family of hosts (`resource.host like "*.example.com"`) only when every subdomain is
yours: a user-controlled subdomain on a shared domain is an exfiltration channel. Carve a path out
with a `forbid` (below).

### A local server by exact package name, pinned

Use it when a repo runs one known package. The permit fixes the whole argument list, so the
definition has to be this command with exactly these arguments; `pinned` stays as a second check.
A version bump is a reviewed edit of the permit (plain form) or of the permit plus one more decision
(approved form).

```cedar
// cookbook: npx-package
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "stdio" && resource.command == "npx" && resource.pinned &&
    resource.args == ["-y", "@example/docs-mcp@1.4.2"]
  };
```

```cedar
// cookbook: npx-package-approved
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "stdio" && resource.command == "npx" && resource.pinned &&
    resource.args == ["-y", "@example/docs-mcp@1.4.2"] && context.approved
  };
```

```cedar
// cookbook: uvx-package
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "stdio" && resource.command == "uvx" && resource.pinned &&
    resource.args == ["example-mcp==1.4.2"]
  };
```

```cedar
// cookbook: uvx-package-approved
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "stdio" && resource.command == "uvx" && resource.pinned &&
    resource.args == ["example-mcp==1.4.2"] && context.approved
  };
```

Security: the permit matches this exact argument list only. `resource.args` is a Cedar set, and
`==` on sets ignores order and repeats, so `["-y", "pkg"]` also matches `["pkg", "-y"]`; because the
set holds one package and otherwise only flags, that package is the one that runs. A different
first package, an extra argument (including one after `--`) and a missing flag do not match.
Cedar cannot match a pattern over the elements, so there is no "any version of this package"
permit. A pinned package still runs arbitrary code with the job's secrets in its environment. A git
source works the same way, with the full argument list as in
[Pinned git sources](#operator-policy).

### Any pinned local server

See [Allow any pinned local server](#operator-policy) for both forms (with and without
`context.approved`) and why the approved one is preferred. It is the broadest local permit; the
recipes above narrow it by package.

### A ceiling no permit can override

Use it for what no repo may ever run. A `forbid` in the global file or in the repo's file wins over
every permit in either file and over every approval. Put what must hold for all repos in
`infra/mcp-policy.cedar`; a repo's own `forbid` only narrows that repo.

```cedar
// cookbook: forbid-admin-path
forbid(principal, action == Action::"UseServer", resource)
  when { resource.url like "https://mcp.example.com/admin/*" };
```

With the host recipes this allows the host except that path. Matching on `like` is exact text, so
write the ceiling for every spelling of what you mean to block, or invert it with
`forbid ... unless { ... }` so that only what you list can pass, which is how the global ceiling is
written.

## Launching servers

A local (stdio) server is a process the turn starts on the runner, so what it can launch depends on
the toolchains on that runner. This section covers `command` servers; remote servers need none of
it.

### Runner toolchains

A turn job runs on the caller's `runs-on` (`ubuntu-latest` in the [example workflows](workflows.md)).
Centaur installs only what its own scripts need, in `setup-runtime`:

- Node, `npx` and `yarn`: `actions/setup-node` with the version in Centaur's `.nvmrc`, then
  `corepack enable`.
- `uv` and `uvx`: `astral-sh/setup-uv` (the action's version is pinned; it is not told a `uv` version).

Everything else is whatever the runner image ships, which Centaur neither selects nor pins and
which changes with the image. The [Ubuntu 24.04 image list](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
includes Python 3 with `pip`, Rust with `cargo` and `rustup`, and Docker. It lists Go under cached
tools (several versions); whether `go` is on `PATH` by default is not something Centaur checks, so
install it explicitly. The `ubuntu-latest` label moves to a new image over time, and a
self-hosted runner has none of this.

Centaur does not provide a Python, Go or Rust toolchain at a version of your choosing. A consumer
that needs one installs it in its own workflow, in a step before the `turn` action (for example
`actions/setup-python`, `actions/setup-go` with a `go.mod`, or a Rust toolchain action or
`rust-toolchain.toml`), so the version is pinned in the reviewed workflow.

### Launcher, policy and pinning

Which launchers the policy can reason about:

| `command` | `pinned` | What the policy sees |
|---|---|---|
| `npx` | recognised | the package is an exact version or a commit SHA, or `pinned` is `false` |
| `uvx` | recognised | the same, for `pkg==1.4.2` or a commit SHA |
| `cargo`, `go`, anything else | always `false` | the command and its arguments, nothing about what they build or run |

[`isPinned`](#operator-policy) (`src/config/mcp-policy.ts`) recognises only `npx` and `uvx`, so
`cargo run`, `go run` and an installed binary are all "any other command". They are allowed only by
a `permit` that does not need `resource.pinned`: one that names the `command` (and, for an exact
match, `args`), preferably with `context.approved` so the admin or an approver confirms the exact
definition. The broad "any pinned local server" permit never matches them. Cedar cannot verify a
version, a module or crate source, or the checksum of what they fetch, so the pin is whatever the
reviewed workflow and arguments say.

The practical pattern for a Rust or Go server is to build or fetch a fixed version in an earlier
workflow step and let the server entry launch the resulting binary:

```yaml
mcp_servers:
  example:
    command: example-mcp-server
    args: ["--stdio"]
```

with the install in the caller workflow before the `turn` step, for example
`cargo install --locked --version 1.4.2 example-mcp-server` or
`go install example.com/mcp/example-mcp-server@v1.4.2`, plus the toolchain's bin directory on
`PATH`. The policy then permits that command by name (and `args`) rather than a package, so the
version lives in the workflow, not in anything the policy checks. Launching with `cargo run` or
`go run` in the config instead compiles and runs at turn time, and nothing pins it. Containers
(`docker run`) are [out of scope](#out-of-scope).

### Install scripts

Whatever installs or launches a server can run code before the server starts: npm `postinstall`,
a Rust `build.rs`, `go generate` and `cgo`, Python `setup.py` or build backends. That code runs in
the turn with the job's credentials and the server's `env` in reach. Pinning fixes which code
runs; it does not make it safe. Keep `Bash` out of `allowed_tools` for a bot that runs local
servers ([Residual exposure](#secrets)), use the narrow permits in the
[cookbook](#permit-cookbook) with `context.approved`, and prefer a pinned git SHA or exact version
as described in [Trust model](#trust-model).

## Out of scope

- Per-turn or per-prompt server sets (all prompts and chat turns share `mcp_servers`).
- OAuth flows and servers that need an interactive login; only static tokens through headers or env.
- Running servers as long-lived processes across turns, or any server hosted by Centaur.
- Starting containers (`docker run` servers).
- Reading `.mcp.json` from the consumer repo.
- A per-secret allowlist enforced by Centaur: the caller `env:` is the allowlist.
- The agent editing `mcp_servers` without review (pull requests stay the gate).

## Implementation plan

1. Schema and validation: add `mcp_servers`, `secretRef`, the name refinements and the
   `allowed_tools` cross-checks to `src/config/schema.ts`, with tests in the existing config test
   file for each rejection above. Update [config.md](config.md) fields table and the cost table
   (servers add tool-list tokens). No behaviour change for configs without `mcp_servers`.
2. Config to JSON: a pure `buildMcpConfig(servers, env)` in `src/workflows/` that returns the JSON and
   the list of missing secret names; unit tests cover both shapes, `prefix`, and the missing case.
3. `prepare`: write `.centaur-turn/mcp.json`, extend `buildClaudeArgs` with `--mcp-config`, fail
   the turn on missing secrets. Tests extend the existing prepare tests with a fake env.
4. Caller-workflow docs: update the three example workflows in [workflows.md](workflows.md) and
   [onboarding.md](onboarding.md) with the `env:` pattern, and describe the secret handling and the
   `Bash` caveat. Add the `mcp.json` step to the Agent turn section.
5. Verify end to end against one real server (a remote one) in a consumer repo, confirming `${VAR}`
   expansion for `--mcp-config` files and the `mcp__<server>__*` wildcard under the pinned
   `claude-code-action` version.
6. Policy: the global `infra/mcp-policy.cedar` plus the repo's `.centaur/mcp-policy.cedar`, read from the default branch and enforced in
   `register` and `prepare` ([Operator policy](#operator-policy)).

## Decisions

The maintainer accepted every recommendation below.

1. **Secret transport.** Caller `env:` on the `turn` step (C) vs a JSON input of named secrets (D).
   Recommendation: C.
2. **Secret in the file or by reference.** Write `${NAME}` references and rely on MCP config
   expansion, vs writing values to a `0600` file. Recommendation: references, with the file as the
   fallback if expansion does not work for `--mcp-config`.
3. **Automatic allow-listing.** Allow every tool of every configured server, vs require entries in
   `allowed_tools`. Recommendation: require explicit entries, validated against `mcp_servers`.
4. **Wildcard or per-tool.** Allow `mcp__<server>__*`, or require per-tool names. Recommendation: allow
   both; document per-tool for servers with write tools.
5. **Local `command` servers.** Permit them in the schema at all, or ship URL servers only first.
   Recommendation: schema accepts both, but the first release enforces nothing beyond pinning
   guidance, and the operator policy rejects everything, `command` servers included, until a policy permits it.
6. **Operator policy location.** SSM parameter owned by the admin vs a repo file. Decided: a repo file
   at a fixed path, always read from the default branch, plus a global file bundled with the Lambda
   for the operator's ceiling, so neither needs AWS state.
7. **Config source for turns.** Keep reading the default branch (current behaviour). Recommendation:
   keep, and state it as an invariant in [workflows.md](workflows.md).
8. **Reserved names.** Reject `github*` server names. Recommendation: yes, since the action lets a
   same-named custom server replace its built-in one.
9. **Transport types.** Support `http` only for remote servers, not `sse`. Recommendation: `http` only;
   add `sse` if a needed server requires it.
10. **Dead servers.** Error vs warn when a server has no `allowed_tools` entry. Recommendation: error,
    to keep config and permissions in step.
