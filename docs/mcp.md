# Additional MCP servers (design)

Status: implemented and verified against the remote GitHub MCP server, using the Actions token as the
bearer. `prepare` writes the config and the turn fails on a missing secret. This describes how a consumer repo adds MCP servers to a turn through
`.centaur.yml` ([config.md](config.md), [workflows.md](workflows.md#agent-turn)). The agent has no
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
- the trust policy below, if the repo or the operator configures one.

Checked only at turn time, in `prepare`: every `{secret: NAME}` has a non-empty environment variable
`NAME`. A missing one fails the turn with the name and the caller-workflow line that supplies it,
rather than starting a server that fails to authenticate.

## Secrets

Composite actions cannot read `secrets.*` themselves; only the caller workflow can. `turn` already
takes the two model keys as inputs for this reason, but arbitrary names defined in `.centaur.yml`
cannot be declared as inputs in advance. Options:

| Option | Mechanism | Assessment |
|---|---|---|
| A. Fixed inputs | `mcp_secret_1 ... mcp_secret_N` | Arbitrary cap, names unrelated to the config. Rejected. |
| B. One JSON input | Caller passes `mcp_secrets: ${{ toJSON(secrets) }}` | Hands every repo secret to the step, including ones no server asked for. A config edit could then read any of them. Rejected. |
| C. Caller `env:` | Caller sets `env: { LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }} }` on the `turn` step; `prepare` reads `process.env[NAME]` | The caller lists exactly the secrets it is willing to expose; the config can only reference those. |
| D. Caller JSON of named secrets | `mcp_secrets: ${{ toJSON({LINEAR_API_KEY: secrets.LINEAR_API_KEY}) }}` | Same exposure as C with an extra parse step and an input to document. |

Recommendation: C. The caller workflow is the consent boundary: a secret reaches the turn only when
the consumer wrote a line naming it, and a `.centaur.yml` edit cannot widen that set. Env set on the
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

Which config a turn reads: `prepare` reads `.centaur.yml` from the workspace, which the caller's
`actions/checkout` populates. The caller workflows run on `repository_dispatch` and `schedule`,
which GitHub only runs from the default branch, and check out its head. So turns read config from
the default branch, never from a pull request branch. The agent's own pull requests
(`centaur/<bot>-<thread>`) can edit `.centaur.yml`, but the edit has no effect until a human merges
it. `register` also runs on pushes to the default branch.

Consequences:

- Anyone who can merge to the default branch can add a server. This is the same set that can already
  edit the caller workflow and `allowed_tools`, so servers do not widen who is trusted; they make
  what a merge grants less obvious in a diff.
- A bot-authored pull request that adds a server is the realistic attack: a prompt-injected agent
  proposes `mcp_servers` plus `allowed_tools` entries that exfiltrate secrets. Review of
  `.centaur.yml` changes in agent pull requests is the control, which is why the mitigations below
  make the dangerous shapes fail validation instead of relying on a reviewer to notice them.
- Another workflow (a manual `workflow_dispatch` on a feature branch) can run a turn from a branch
  config. That is the maintainer's explicit act and needs no extra handling.
- A checked-out repo may contain its own `.mcp.json`. The action does not pick it up as trusted
  config today; keep this out of scope and do not rely on it.

Mitigations, in order of recommendation:

1. Secrets only through the caller `env:` (above). A merged config cannot reach a secret the caller
   did not list.
2. Policy file owned by the operator, not the repo: an optional `/centaur/policy/mcp` SSM parameter
   (allowed `url` host patterns, allowed `command` values with required version pin pattern) that
   `prepare` and `register` check. Config that violates it fails registration and the turn. It is
   outside any pull request's reach, matching the "no allowlist in the repo" decision for chat
   access ([config.md](config.md#design-decisions)).
3. Remote servers only by default: reject `command` servers unless the policy permits specific
   commands. Remote servers cannot run code on the runner.
4. Pinned packages: when `command` is allowed, require `npx`/`uvx` arguments to carry an exact
   version (`pkg@1.4.2`) and reject `@latest` or unpinned names, so a registry publish cannot change
   what runs. Container images by digest if `docker` is ever allowed.
5. Surface changes: `register` (which runs on merge to the default branch) lists the configured
   servers in its job summary so additions are visible after the fact.

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
6. Policy (separate change): the SSM policy parameter, CLI support (`centaur mcp-policy set/show`),
   and enforcement in `register` and `prepare`.

Steps 1 to 5 deliver the feature with caller-`env:` secrets as the only gate; step 6 hardens it and
can follow.

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
   guidance, and the policy in step 6 defaults to rejecting `command` once it exists.
6. **Operator policy location.** SSM parameter owned by the admin vs a repo file. Recommendation: SSM,
   consistent with access control living outside the repo.
7. **Config source for turns.** Keep reading the default branch (current behaviour). Recommendation:
   keep, and state it as an invariant in [workflows.md](workflows.md).
8. **Reserved names.** Reject `github*` server names. Recommendation: yes, since the action lets a
   same-named custom server replace its built-in one.
9. **Transport types.** Support `http` only for remote servers, not `sse`. Recommendation: `http` only;
   add `sse` if a needed server requires it.
10. **Dead servers.** Error vs warn when a server has no `allowed_tools` entry. Recommendation: error,
    to keep config and permissions in step.
