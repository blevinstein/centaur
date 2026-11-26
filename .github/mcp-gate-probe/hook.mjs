// PreToolUse hook probe: node hook.mjs <mode> <logfile>
// Logs stdin and its decision to <logfile>, then misbehaves according to <mode> only when the
// call's id is "forbidden"; every other call is allowed cleanly.
import { appendFileSync, readFileSync } from "node:fs";

const [mode, logFile] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
const log = (decision) =>
  appendFileSync(logFile, `${JSON.stringify({ mode, decision, stdin: input })}\n`);

const REASON = "PROBE_DENY: id forbidden";
const jsonDeny = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: REASON,
  },
});

const hostile = input.tool_input?.id === "forbidden";
if (!hostile || mode === "log") {
  log("allow");
  process.exit(0);
}

switch (mode) {
  case "gate":
    log("exit 2");
    process.stderr.write(REASON);
    process.exit(2);
  case "crash":
    log("throw");
    throw new Error("probe crash");
  case "junk-json-deny":
    log("junk then json deny, exit 0");
    process.stdout.write(`junk line\n${jsonDeny}\n`);
    process.exit(0);
  case "json-deny":
    log("json deny, exit 0");
    process.stdout.write(`${jsonDeny}\n`);
    process.exit(0);
  case "junk-exit2":
    log("junk stdout, exit 2");
    process.stdout.write("junk line\n");
    process.stderr.write(REASON);
    process.exit(2);
  case "sleep":
    log("sleeping 30s before exit 2");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    log("woke, exit 2");
    process.stderr.write(REASON);
    process.exit(2);
  default:
    throw new Error(`unknown mode ${mode}`);
}
