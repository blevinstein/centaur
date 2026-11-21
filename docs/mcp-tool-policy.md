# Per-call MCP policy

Status: **proposal**, not built on `main`. This document is the plan behind the backlog item in
[TODO.md](../TODO.md#backlog). It builds on [mcp.md](mcp.md#operator-policy).

A first cut of the design below (the `CallTool` evaluator, the `tool-gate` hook, tests and its
`mcp.md` section) lives on the branch [`proposal/mcp-tool-policy-first-cut`](https://github.com/blevinstein/centaur/tree/proposal/mcp-tool-policy-first-cut). It fails open when the hook itself
crashes, and has none of the validation, lint, audit or settings isolation in the plan. Start from it
or from scratch.

## Problem

The operator policy authorizes each `mcp_servers` entry once, in `prepare` and `register`, against the
server's static launch config (`Action::"UseServer"`). Tool-call arguments never reach it. The only
tool-level control is `allowed_tools` (`mcp__<server>__<tool>`), which cannot match on arguments. So
"this mutating tool, only for these IDs" cannot be expressed today.

## Design

Add `Action::"CallTool"` and evaluate it per call.

- `prepare` writes the merged policy layers (the same global and default-branch repo layers it already
  fetches) and the bot name to the turn state directory, outside the workspace, and writes a Claude Code
  settings file with a `PreToolUse` hook (matcher `mcp__.*`) that it passes with `--settings`.
- The hook runs `centaur-workflow tool-gate` per MCP call with `tool_name` and `tool_input` on stdin. It
  evaluates Cedar with principal `Bot::"<bot>"`, action `Action::"CallTool"`, resource
  `McpTool::"<server>/<tool>"` (attributes `server`, `name`) and `context.args` set to the call's
  arguments.
- Every call is permitted by a built-in baseline `permit`, so `CallTool` policies only restrict: a
  `forbid` that matches denies. Evaluation errors deny. A hook deny overrides `allowed_tools`; an allow
  leaves the decision to `allowed_tools`.
- `null` arguments are dropped and non-integer numbers become strings, because Cedar contexts hold
  neither.

```cedar
forbid(principal, action == Action::"CallTool", resource)
  when { resource.server == "linear" && resource.name == "delete_issue" }
  unless { context.args has id && ["ENG-1", "ENG-2"].contains(context.args.id) };
```

Failure posture once a deployment uses the feature: closed.

## Failure modes and sharp edges

Found by running Cedar edge cases against the evaluator and reading Claude Code's hook documentation.
Facts marked (*) come from a summarizing fetch of that documentation and must be confirmed by the live
experiment below before the design relies on them.

### Authoring mistakes that silently grant too much

| Mistake | Outcome without mitigation | Mitigation |
|---|---|---|
| Action typo, `Action::"CallTools"` | Policy matches nothing; nothing is restricted | Validate against a schema declaring `CallTool`: "unrecognized action" error |
| Attribute typo, `resource.nmae` | Evaluation error, call denied (safe, but found only at runtime) | Same validation, at `config check`, `register` and `prepare` |
| Literal typo or case in a tool or server name (`"delete_issues"`, `"Linear"`) | The `forbid` never matches; the tool is fully open | Lint literals against `mcp_servers` and `allowed_tools`; dry-run command |
| Denylist-style argument rule (`when { args.team == "secret" }`) | Bypassed by another parameter name, case or encoding | Docs show only the allowlist form: `forbid ... when {tool} unless {allowed args}` |
| Allowlist checks `id`, tool also honors `ids` | Passes when both are sent | Cedar cannot iterate keys; docs: also forbid sibling parameters with `context.args has ids` |
| `allowed_tools` is `mcp__srv__*` and the server gains a write tool | New tool is allowed | Docs: server-wide allowlist `unless {["a","b"].contains(resource.name)}`; prefer per-tool `allowed_tools` |
| Unscoped `forbid(principal, action, resource)` aimed at servers | Fails validation on `McpTool` attributes | Authors scope the action; update the `docs/mcp.md` example and test fixtures |

### Hook and runtime failures

| Failure | Claude Code behavior (*) | Mitigation |
|---|---|---|
| Hook exits 1 or crashes before our code (node missing, wrong path, import error) | Non-blocking: the call proceeds | The hook command is a shell wrapper mapping any non-zero exit to 2 |
| Stray stdout before the JSON | JSON not honored: the call proceeds | Deny with exit 2 and the reason on stderr; allow is exit 0 with empty stdout |
| Hook timeout | Non-blocking (default 600 s) | Short explicit `timeout`; `onFailure: "block"` if it applies to `PreToolUse` |
| `claude-code-action` ignores or overrides `--settings` | Hook never runs: everything is allowed | Live check; the post-run audit makes it loud |
| Agent or a PR branch writes `.claude/settings*.json` (settings reload live; `disableAllHooks` exists) | The hook can be removed or disabled | `--setting-sources` excluding project and local settings if supported; otherwise managed settings with `allowManagedHooksOnly` |
| Agent overwrites the policy or settings file in `$RUNNER_TEMP` with Bash | Policy replaced | Same boundary as the turn state; root-owned directory if managed settings are used |
| Policy fetch fails or a layer is invalid | Turn fails in `prepare` (closed, as today) | None needed |

Out of scope: other routes to the same capability (Bash with `curl` or `gh` and secrets in the
environment) are not covered by MCP policy.

## Plan

1. **Schema and validation.** Add `McpTool` and `CallTool` (context `{ args: {} }`) to
   `src/config/mcp-policy-schema.ts`; guarded `context.args has id && context.args.id ...` validates. Drop
   any text-matching of policies: validation guarantees scoping. `validateMcpPolicy` also returns
   validation warnings (impossible policy).
2. **Validate on enforcement.** `src/workflows/mcp-policy-check.ts` validates each layer and fails closed
   on any error or warning, so `register` and `prepare` reject typo'd policies.
3. **Literal lint.** Using cedar-wasm `policyToJson`, collect string literals compared to
   `resource.server` and `resource.name`. Flag servers not in `mcp_servers`, and tool names missing from
   `allowed_tools` for non-wildcarded servers (warn when wildcarded).
4. **Hook.** `src/workflows/tool-gate.ts` and the `tool-gate` command in `src/workflows/cli.ts`: exit-code
   contract above, shell wrapper, explicit timeout. Install whenever `mcp_servers` is non-empty.
5. **Post-run audit.** An `audit-tool-calls` command and an action step before "Post reply" re-evaluate
   every `mcp__*` `tool_use` in `execution_file` (parsing in `src/workflows/finish.ts`) against the stored
   layers, and fail the turn with a failure notice if any would have been denied. It detects a hook that
   did not run, was disabled or failed open; it does not prevent.
6. **Settings isolation.** Restrict setting sources in `buildClaudeArgs` if the flag works; otherwise
   managed settings. Shape depends on the live experiment.
7. **Dry run.** `centaur policy check-call --server S --tool T --args JSON` evaluates local policy files
   with `checkToolCall` and prints the decision and policy id.
8. **Docs.** Fold this into the "Tool-call policy" section of [mcp.md](mcp.md): allowlist form first,
   sibling-parameter and wildcard pitfalls, the exit-2 contract, the audit and the remaining trust boundary.

## Verification

- Unit: each authoring row (action typo, attribute typo, unknown server literal, unknown tool literal,
  unscoped forbid); the hook contract (exit code and stderr on deny, empty stdout on allow, the wrapper
  turning a missing script and a junk-printing script into exit 2); the audit flags a denied call and
  passes a clean transcript.
- `yarn lint`, `yarn typecheck`, `yarn test`, `yarn lint:cfn`, `yarn bundle:lambda` (cedar-wasm stays out
  of the Lambda bundle).
- Live, on an `experiment/*` branch, with the maintainer's approval, against one MCP server with a
  `forbid` on one argument value. Confirm: the hook runs under `claude-code-action@v1` via `claude_args`;
  a refused call is blocked and logged; a deliberately broken hook command blocks rather than allows; a
  `.claude/settings.local.json` with `disableAllHooks`, written by the agent or committed on the branch,
  does not disable the gate; the audit fails the run when the hook is omitted; `--setting-sources`,
  `onFailure` and MCP server-name normalization behave as the documentation summary says.
