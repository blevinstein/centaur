import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { CHAT_SERVER_ENV } from "../../src/mcp/server-config.js";
import type { TurnState } from "../../src/workflows/prepare.js";
import { writeOidcCredentials, writeTurnState } from "../../src/workflows/turn-state.js";
import { scannedRange } from "./chat-context-fixtures.js";
import { CURRENT, searchHit, summary } from "./chat-server-fixtures.js";

const ENTRY = join(import.meta.dirname, "../../src/mcp/chat-server-main.ts");

/** A stand-in for the `aws` CLI that answers `lambda invoke` from the JSON in `FAKE_POSTER_RESPONSES`. */
const FAKE_AWS = `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const payload = JSON.parse(readFileSync(args[args.indexOf("--payload") + 1].replace("file://", ""), "utf8"));
const responses = JSON.parse(process.env.FAKE_POSTER_RESPONSES);
writeFileSync(args.at(-1), JSON.stringify(responses[payload.operation]));
process.stdout.write(JSON.stringify({ StatusCode: 200 }));
`;

export async function startChatServerProcess(options: { slackSearch?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "centaur-chat-stdio-"));
  const bundle = join(dir, "chat-server-main.mjs");
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await writeFile(join(dir, "aws"), FAKE_AWS);
  await chmod(join(dir, "aws"), 0o755);

  const tokens = createServer((_request, response) =>
    response.end(JSON.stringify({ value: "jwt" })),
  );
  await new Promise<void>((resolve) => tokens.listen(0, "127.0.0.1", resolve));
  const state: TurnState = {
    mode: "reply",
    bot: "sprout",
    threadId: CURRENT,
    policy: "transcript",
    sessionDirectory: dir,
  };
  await writeTurnState(join(dir, "state"), state);
  await writeOidcCredentials(join(dir, "state"), {
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${(tokens.address() as AddressInfo).port}/token?v=1`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer",
  });

  const responses = {
    "list-threads": {
      threads: [summary(CURRENT), summary("telegram:-1001234567890:9")],
      scanned: scannedRange(3, true),
    },
    "search-chat": {
      status: "ok",
      results: [searchHit()],
    },
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    stderr: "pipe",
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_POSTER_RESPONSES: JSON.stringify(responses),
      CENTAUR_FUNCTION_NAME: "poster-fn",
      CENTAUR_OIDC_AUDIENCE: "centaur",
      [CHAT_SERVER_ENV.stateDir]: join(dir, "state"),
      [CHAT_SERVER_ENV.maxThreads]: "5",
      [CHAT_SERVER_ENV.maxMessages]: "10",
      ...(options.slackSearch ? { [CHAT_SERVER_ENV.slackSearch]: "1" } : {}),
    },
  });
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(transport);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await new Promise((resolve) => tokens.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
