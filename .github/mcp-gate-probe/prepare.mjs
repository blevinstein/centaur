// node prepare.mjs matrix <only>  -> writes the scenario id list as a JSON `matrix` output
// node prepare.mjs <id>           -> writes the probe files and the `prompt` and `claude_args` outputs
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promptFor, scenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const probeDir = join(process.env.RUNNER_TEMP, "probe");
const output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));

const [command, only = ""] = process.argv.slice(2);

if (command === "matrix") {
  const wanted = only.split(",").map((s) => s.trim()).filter(Boolean);
  const ids = scenarios.map((s) => s.id).filter((id) => !wanted.length || wanted.some((w) => id.startsWith(w)));
  output("matrix", JSON.stringify(ids));
  process.exit(0);
}

const s = scenarios.find((candidate) => candidate.id === command);
if (!s) throw new Error(`unknown scenario ${command}`);

mkdirSync(probeDir, { recursive: true });
const hookCommand =
  s.mode === "missing"
    ? "node /nonexistent/hook.mjs"
    : `node ${join(here, "hook.mjs")} ${s.mode} ${join(probeDir, "hook.log")}`;
const settingsFile = join(probeDir, "settings.json");
writeJson(settingsFile, {
  hooks: {
    PreToolUse: [
      {
        matcher: "mcp__.*",
        hooks: [
          {
            type: "command",
            command: hookCommand,
            ...(s.timeout ? { timeout: s.timeout } : {}),
            ...(s.onFailure ? { onFailure: s.onFailure } : {}),
          },
        ],
      },
    ],
  },
});

const mcpFile = join(probeDir, "mcp.json");
writeJson(mcpFile, {
  mcpServers: Object.fromEntries(
    s.servers.map((name) => [
      name,
      {
        command: "node",
        args: [join(here, "server.mjs"), name],
        env: { PROBE_DIR: probeDir },
      },
    ]),
  ),
});

for (const [path, content] of Object.entries(s.workspaceFiles ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const allowed = [
  ...s.servers.map((name) => `mcp__${name}__*`),
  ...(s.agentWrites ? ["Write"] : []),
].join(",");
const args = [
  "--model claude-haiku-5-5",
  "--max-turns 8",
  `--settings ${settingsFile}`,
  `--mcp-config ${mcpFile}`,
  `--allowedTools "${allowed}"`,
  ...(s.sources ? [`--setting-sources ${s.sources}`] : []),
];
output("probe_dir", probeDir);
output("prompt", promptFor(s));
output("claude_args", args.join(" "));
console.log(readableSummary(s, args));

function readableSummary(scenario, claudeArgs) {
  return [`scenario ${scenario.id}: ${scenario.question}`, `claude_args: ${claudeArgs.join(" ")}`].join("\n");
}
