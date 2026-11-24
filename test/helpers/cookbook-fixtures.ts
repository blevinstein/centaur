import { readFileSync } from "node:fs";
import { mcpServersFrom } from "./config-fixtures.js";

export const cookbookSnippets = (): Record<string, string> => {
  const section = readFileSync("docs/mcp.md", "utf8").split("\n## Permit cookbook")[1] ?? "";
  const blocks = [...section.matchAll(/```cedar\n\/\/ cookbook: (\S+)\n([\s\S]*?)```/g)];
  return Object.fromEntries(blocks.map(([, id, policy]) => [id, (policy ?? "").trim()]));
};

export const remoteAt = (url: string) => mcpServersFrom(`  svc:\n    url: ${url}\n`);

export const stdioArgs = (command: string, args: string[]) =>
  mcpServersFrom(`  svc:
    command: ${command}
    args: ${JSON.stringify(args)}
`);
