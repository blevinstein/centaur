# Per-call MCP policy

Status: **built** (steps 1 to 8). The schema and validation, validation on `register` and `prepare`
(fail closed on any error or warning), the literal lint, the `tool-gate` hook with its shell wrapper,
exit-2 contract and `onFailure: "block"`, `--setting-sources user` on every turn with the gate, the
post-run audit, `centaur policy check-call` and the docs ([mcp.md](../mcp.md#tool-call-policy)). The
facts below were confirmed on 2026-11-26 by a live probe of `claude-code-action@v1` with Claude Code
2.1.332 (run 45839864607). The gate is installed only when `mcp_servers` is non-empty, so a config with
just `chat_tools.scope: chat` has no gate. The audit step runs straight after the agent rather than
just before "Post reply", so a refused call also stops the push of the turn's changes. It builds on
[mcp.md](../mcp.md#operator-policy) and is the plan behind the backlog item in
[TODO.md](../../TODO.md#backlog).

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

Found by running Cedar edge cases against the evaluator, then confirmed against a live
`claude-code-action@v1` run on Claude Code 2.1.332 (2026-11-26).

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

| Failure | Claude Code behavior (confirmed) | Mitigation |
|---|---|---|
| Hook exits 1, crashes or its script is missing | Fails open: the call proceeds | `onFailure: "block"` on the hook entry (Claude Code 2.1.295 or later) blocks; the shell wrapper also maps any non-zero exit to 2 |
| Junk on stdout, then a JSON deny with exit 0 | Fails open | Deny with exit 2 and the reason on stderr; allow is exit 0 with empty stdout; the wrapper turns any stdout into exit 2. (A clean JSON deny blocks, and junk with exit 2 blocks.) |
| Hook timeout | Fails open | A 15 second explicit `timeout` plus `onFailure: "block"`, which blocks a timeout |
| `--settings` with a `PreToolUse` hook, matcher `mcp__.*` | Runs under the action; exit 2 blocks and the stderr reason is in the transcript | Used as is |
| A committed `.claude/settings.json` or `settings.local.json` with `disableAllHooks` | Does not disable a hook passed with `--settings`, with or without `--setting-sources` | None needed |
| The agent writes `.claude/settings.local.json` `{"disableAllHooks": true}` mid-run | Disables the gate (the hook ran 0 times) unless `--setting-sources user` is passed; with it the gate held | `--setting-sources user` on every turn that installs the gate (step 6) |
| Server names | Hyphens and underscores reach the hook exactly (`mcp__probe-srv__echo_id`); a server named `probe.srv` was never connected | The config schema already limits names to `[a-z0-9_-]` without `__`; a dotted name fails `config check`, `register` and `prepare` |
| Agent overwrites the saved policy or settings in `$RUNNER_TEMP` with Bash | Policy replaced | Same boundary as the turn state; the audit reads the same files, so it does not catch this |
| Policy fetch fails or a layer is invalid | Turn fails in `prepare` (closed, as today) | None needed |

Out of scope: other routes to the same capability (Bash with `curl` or `gh` and secrets in the
environment) are not covered by MCP policy. Also not covered: the user-scope files under `$HOME/.claude`
(`settings.json` and others), which `--setting-sources user` still loads. The probe wrote only
project-local settings, so whether a user-scope `disableAllHooks` disables a hook passed with
`--settings` is untested. The agent's file tools are confined to the workspace, but its `Bash` tool,
when `allowed_tools` includes it, can write under `$HOME`. Treat the gate as unisolated from a `Bash`
tool; the audit is the backstop.

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
4. **Hook.** `src/workflows/tool-gate.ts` and the `tool-gate` command in `src/workflows/program.ts`: exit-code
   contract above, shell wrapper, explicit timeout. Install whenever `mcp_servers` is non-empty.
5. **Post-run audit.** An `audit-tool-calls` command and an action step before "Post reply" re-evaluate
   every `mcp__*` `tool_use` in `execution_file` (parsing in `src/workflows/finish.ts`) against the stored
   layers, and fail the turn with a failure notice if any would have been denied. It detects a hook that
   did not run, was disabled or failed open; it does not prevent.
6. **Settings isolation.** `buildClaudeArgs` passes `--setting-sources user` whenever the gate's
   `--settings` file is passed (and, as before, on comment turns). Chat and scheduled turns with
   `mcp_servers` therefore stop reading the workspace's `.claude/settings*.json`, project skills and
   rules; the repository instructions and consumer skills `prepare` copies into `$HOME/.claude` still load.
7. **Dry run.** `centaur policy check-call --server S --tool T --args JSON` evaluates local policy files
   with `checkToolCall` and prints the decision and policy id.
8. **Docs.** Fold this into the "Tool-call policy" section of [mcp.md](../mcp.md): allowlist form first,
   sibling-parameter and wildcard pitfalls, the exit-2 contract, the audit and the remaining trust boundary.

## Verification

- Unit: each authoring row (action typo, attribute typo, unknown server literal, unknown tool literal,
  unscoped forbid); the hook contract (exit code and stderr on deny, empty stdout on allow, the wrapper
  turning a missing script and a junk-printing script into exit 2); the audit flags a denied call and
  passes a clean transcript.
- `yarn lint`, `yarn typecheck`, `yarn test`, `yarn lint:cfn`, `yarn bundle:lambda` (cedar-wasm stays out
  of the Lambda bundle).
- Live, 2026-11-26, Claude Code 2.1.332, run 45839864607, against one MCP server with a `forbid` on one
  argument value: the confirmed behavior is in the table above. Not probed: a user-scope
  `disableAllHooks`, and the audit failing a real run whose hook was omitted.
