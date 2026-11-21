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
  linear:                        # name: alias, becomes the tool prefix mcp__linear__*
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
both `url` and `command`, or neither, fails. `serverName` is the existing `alias` further refined to
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
   version (`pkg@1.4.2`) and reject `@latest` or unpinned names, so a registry publish cannot change
   what runs. Container images by digest if `docker` is ever allowed.
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

The check reads the global layer through the poster's argument-free `get-mcp-policy` operation,
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
| `pinned` (bool) | `false` | the first argument not starting with `-` ends in an exact version, such as `pkg@1.4.2` or `pkg==1.4.2` (not `@latest`, a range or a bare name) |

A server is allowed when some `permit` matches and no `forbid` does. Policy templates are not
supported.

This repo's own policy permits only the read-only endpoints of the remote GitHub MCP server:

```cedar
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "remote" &&
    resource.host == "api.githubcopilot.com" &&
    (resource.url == "https://api.githubcopilot.com/mcp/readonly" ||
     resource.url like "https://api.githubcopilot.com/mcp/x/*/readonly")
  };
```

The server enforces the `/readonly` path, so the agent cannot reach a write tool even if
`allowed_tools` names one; matching the exact URL pins that. A bare `https://api.githubcopilot.com/mcp/`
is denied. Other examples:

```cedar
permit(principal == Bot::"garden", action == Action::"UseServer", resource)
  when { resource.transport == "stdio" && resource.command == "npx" && resource.pinned };

forbid(principal, action, resource) when { resource.host like "*.untrusted.example" };
```

### Tool-call policy

`UseServer` is decided once, in `prepare`. To restrict individual tool calls by their arguments,
write `CallTool` policies. `prepare` writes the merged layers (read from the same sources) to the turn
state directory and passes Claude Code a `PreToolUse` hook (`--settings`) that runs
`centaur-workflow tool-gate` before every `mcp__*` call. The hook evaluates the call and, if refused,
denies it before it runs; otherwise `allowed_tools` still decides. Non-MCP tools are not checked.

Each call is a request: principal `Bot::"<bot>"`, action `Action::"CallTool"`, resource
`McpTool::"<server>/<tool>"` with attributes `server` and `name`, and `context.args` holding the
call's arguments. Every call is permitted unless a `forbid` matches, so `CallTool` policies restrict
and never need a matching `permit`. Only policies that name `CallTool` apply; server-level policies do
not affect tool calls.

```cedar
// delete_issue only for these issues
forbid(principal, action == Action::"CallTool", resource)
  when { resource.server == "linear" && resource.name == "delete_issue" }
  unless { context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id) };
```

- Guard each argument with `has`. A policy that errors, for example on a missing argument, refuses the
  call, as do a missing or unreadable policy file and any hook failure.
- `null` arguments are dropped and non-integer numbers become strings, because Cedar contexts cannot
  hold either.
- `centaur config check` parses `CallTool` policies but cannot type-check them against the schema, since
  arguments are open-ended.
- The policy and hook settings live in the turn state directory, outside the workspace, the same trust
  boundary as the turn state.

**Protect the file.** Require review on `.centaur/mcp-policy.cedar` with a `CODEOWNERS` entry or a
repository ruleset, since anyone who can merge a change to it can permit any server.

**Protect the global file.** It ships with a deploy, so changes need the deployer's normal review.
The global layer is the only part a repo owner cannot change.

Check a config and its policy locally with `centaur config check [path]`. That command reads the
local `.centaur/mcp-policy.cedar` next to the config, which is convenient for editing but is not what
enforcement uses. Add `--global-policy infra/mcp-policy.cedar` to check against the global layer too.

A third outcome, allowed after the admin approves, is designed in [mcp-approval.md](mcp-approval.md).

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
