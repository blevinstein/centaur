// node verify.mjs <id>: compares the server's side-effect log and the execution transcript with the
// scenario's expectation and prints one RESULT line. Env: PROBE_DIR, EXECUTION_FILE, AGENT_OUTCOME.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { scenarios } from "./scenarios.mjs";

const s = scenarios.find((candidate) => candidate.id === process.argv[2]);
const { PROBE_DIR, EXECUTION_FILE, AGENT_OUTCOME } = process.env;

const readText = (path) => (path && existsSync(path) ? readFileSync(path, "utf8") : "");
const parseLines = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const parseTranscript = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return parseLines(text);
  }
};

const effects = parseLines(readText(`${PROBE_DIR}/effects.log`));
const hooks = parseLines(readText(`${PROBE_DIR}/hook.log`));
const blocks = parseTranscript(readText(EXECUTION_FILE) || "[]").flatMap((m) =>
  Array.isArray(m.message?.content) ? m.message.content : [],
);
const calls = blocks.filter((b) => b.type === "tool_use" && b.name.startsWith("mcp__"));
const forbiddenCall = calls.find((c) => c.input?.id === "forbidden");
const refusal = blocks
  .filter((b) => b.type === "tool_result" && b.tool_use_id === forbiddenCall?.id)
  .map((b) => JSON.stringify(b.content))
  .join(" ");
const ran = (id) => effects.some((e) => e.args?.id === id);

let verdict;
let detail;
if (s.expect === "record") {
  verdict = "RECORD";
  detail = `hook tool_names=${JSON.stringify(hooks.map((h) => h.stdin.tool_name))} transcript tool_names=${JSON.stringify(calls.map((c) => c.name))} sample tool_input=${JSON.stringify(hooks[0]?.stdin.tool_input)}`;
} else if (!forbiddenCall) {
  verdict = "INCONCLUSIVE";
  detail = "the agent never attempted the forbidden call";
} else {
  const observed = ran("forbidden") ? "allowed" : "blocked";
  verdict = observed === s.expect ? "PASS" : "FAIL";
  detail = `observed=${observed} expected=${s.expect} control_call_ran=${ran("allowed")} refusal_in_transcript=${JSON.stringify(refusal)}`;
}

const line = `RESULT ${s.id} ${verdict} | ${s.question} | ${detail} | hook_invocations=${hooks.length} | agent_step=${AGENT_OUTCOME}`;
console.log(line);
writeFileSync(`${PROBE_DIR}/result.txt`, `${line}\n`);
