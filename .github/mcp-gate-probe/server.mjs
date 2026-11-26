// Minimal stdio MCP server (newline-delimited JSON-RPC) with two tools, echo_id and other.
// Every tools/call appends a line to $PROBE_DIR/effects.log: the observable side effect.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [serverName] = process.argv.slice(2);
const effectsLog = `${process.env.PROBE_DIR}/effects.log`;

const tools = [
  {
    name: "echo_id",
    description: "Echo the given id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  { name: "other", description: "Do nothing.", inputSchema: { type: "object", properties: {} } },
];

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

function handle({ id, method, params }) {
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "0.0.0" },
    });
  }
  if (method === "tools/list") return reply(id, { tools });
  if (method === "tools/call") {
    appendFileSync(
      effectsLog,
      `${JSON.stringify({ server: serverName, tool: params.name, args: params.arguments })}\n`,
    );
    return reply(id, {
      content: [{ type: "text", text: `ok:${params.name}:${params.arguments?.id ?? ""}` }],
    });
  }
  if (id !== undefined) reply(id, {});
}

createInterface({ input: process.stdin }).on("line", (line) => handle(JSON.parse(line)));
