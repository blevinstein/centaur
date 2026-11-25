import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_SERVER_ENV } from "../src/mcp/server-config.js";
import { CHAT_SERVER_ENTRY } from "../src/workflows/mcp-config.js";
import { MCP_CONFIG_FILE, PROMPT_FILE, prepare } from "../src/workflows/prepare.js";
import { OIDC_CREDENTIALS_FILE_NAME } from "../src/workflows/turn-state.js";
import { envRef } from "./helpers/config-fixtures.js";
import { fakePolicyGitHub, PERMIT_ANY_REMOTE } from "./helpers/mcp-policy-fixtures.js";
import { commentSetup, prComment } from "./helpers/pr-comment-fixtures.js";
import { CHAT_CONFIG, chatConfigText, POSTER_ENV, setup } from "./helpers/turn-fixtures.js";
import {
  configText,
  createWorkspace,
  mcpConfigText,
  message,
} from "./helpers/workflow-fixtures.js";

const read = (root: string, file: string) => readFile(join(root, file), "utf8");
const BLOCK = "`centaur-chat` server";
const TOOLS_RULE = "mcp__centaur-chat__*";
const OIDC_NAMES = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

describe("prepare with chat context tools", () => {
  it("leaves the turn untouched under the default scope", async () => {
    const { deps, root } = await setup([message("1", "hi")]);

    const out = await prepare(deps({ env: POSTER_ENV }));

    await expect(read(root, MCP_CONFIG_FILE)).rejects.toThrow();
    expect(out.claude_args).not.toContain("--mcp-config");
    expect(out.claude_args).toContain('--allowedTools "Read,Edit"');
    expect(await read(root, PROMPT_FILE)).not.toContain(BLOCK);
  });

  it("starts the built-in server from the trusted dist with references and no secrets", async () => {
    const { deps, root, stateDir } = await setup([message("1", "hi")], chatConfigText());

    const out = await prepare(deps({ env: POSTER_ENV }));

    const written = await read(root, MCP_CONFIG_FILE);
    expect(JSON.parse(written).mcpServers["centaur-chat"]).toEqual({
      type: "stdio",
      command: "node",
      args: [CHAT_SERVER_ENTRY],
      env: {
        ...Object.fromEntries(
          Object.keys(POSTER_ENV)
            .filter((name) => !OIDC_NAMES.includes(name))
            .map((name) => [name, envRef(name)]),
        ),
        [CHAT_SERVER_ENV.stateDir]: stateDir,
        [CHAT_SERVER_ENV.maxThreads]: "7",
        [CHAT_SERVER_ENV.maxMessages]: "30",
      },
    });
    for (const secret of ["bearer-secret", "aws-secret"]) expect(written).not.toContain(secret);
    expect(written).not.toContain("telegram:");
    expect(out.claude_args).toContain(`--mcp-config ${MCP_CONFIG_FILE}`);
    expect(out.claude_args).toContain(`--allowedTools "Read,Edit,${TOOLS_RULE}"`);
    const prompt = await read(root, PROMPT_FILE);
    expect(prompt).toContain(BLOCK);
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("bounded window");
    expect(prompt).not.toContain("pull request descriptions");
  });

  it("keeps the OIDC request credentials in the state directory, out of the workspace", async () => {
    const { deps, root, stateDir } = await setup([message("1", "hi")], chatConfigText());

    await prepare(deps({ env: POSTER_ENV }));

    const written = await read(root, MCP_CONFIG_FILE);
    for (const leaked of [...OIDC_NAMES, "token.example", "bearer-secret"]) {
      expect(written).not.toContain(leaked);
    }
    const file = join(stateDir, OIDC_CREDENTIALS_FILE_NAME);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ACTIONS_ID_TOKEN_REQUEST_URL: POSTER_ENV.ACTIONS_ID_TOKEN_REQUEST_URL,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: POSTER_ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    });
    expect(JSON.parse(written).mcpServers["centaur-chat"].env[CHAT_SERVER_ENV.stateDir]).toBe(
      stateDir,
    );
  });

  it("writes no credentials without chat tools", async () => {
    const { deps, stateDir } = await setup([message("1", "hi")]);

    await prepare(deps({ env: POSTER_ENV }));

    await expect(stat(join(stateDir, OIDC_CREDENTIALS_FILE_NAME))).rejects.toThrow();
  });

  it("resolves the entry beside the running build, outside the workspace", async () => {
    const { root } = await createWorkspace({});

    expect(CHAT_SERVER_ENTRY).toMatch(/[\\/]mcp[\\/]chat-server-main\.js$/);
    expect(CHAT_SERVER_ENTRY.startsWith(root)).toBe(false);
  });

  it("keeps configured servers and their policy checks next to the built-in one", async () => {
    const { deps, root } = await setup(
      [message("1", "hi")],
      mcpConfigText().replace("bot: sprout", `bot: sprout\n${CHAT_CONFIG}`),
    );
    const { deps: mcpPolicy } = fakePolicyGitHub({ policy: PERMIT_ANY_REMOTE });

    await prepare(deps({ env: { ...POSTER_ENV, LINEAR_API_KEY: "lin" }, mcpPolicy }));

    const servers = JSON.parse(await read(root, MCP_CONFIG_FILE)).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["centaur-chat", "linear"]);
  });

  it("rejects a configured server that takes the built-in name", async () => {
    const { deps } = await setup(
      [message("1", "hi")],
      chatConfigText("mcp_servers:\n  centaur-chat: { url: https://x.example/mcp }").replace(
        "Read,Edit",
        `Read,${TOOLS_RULE}`,
      ),
    );

    await expect(
      prepare(deps({ mcpPolicy: fakePolicyGitHub({ policy: PERMIT_ANY_REMOTE }).deps })),
    ).rejects.toThrow(/must not define "centaur-chat"/);
  });

  it("uses the configured instruction file for the prompt block", async () => {
    const { deps, root } = await setup(
      [message("1", "hi")],
      chatConfigText("instructions: { chat_tools: .centaur/chat-tools.md }"),
      { ".centaur/chat-tools.md": "Custom chat tools guidance." },
    );

    await prepare(deps({ env: POSTER_ENV }));

    const text = await read(root, PROMPT_FILE);
    expect(text).toContain("Custom chat tools guidance.");
    expect(text).not.toContain(BLOCK);
  });

  it("adds no server and no guidance to a scheduled turn without a dispatched thread", async () => {
    const { deps, root } = await setup(
      [],
      chatConfigText("prompts: {weekly: {context: fresh, destination: household}}"),
    );

    const out = await prepare(deps({ promptName: "weekly", clientPayload: undefined }));

    await expect(read(root, MCP_CONFIG_FILE)).rejects.toThrow();
    expect(out.claude_args).not.toContain(TOOLS_RULE);
    expect(await read(root, PROMPT_FILE)).not.toContain(BLOCK);
  });

  it("reads the scope from the trusted config root on a comment turn", async () => {
    const { deps, root, stateDir } = await commentSetup({
      comments: [prComment(1, "rename it")],
    });
    const trusted = await createWorkspace({
      ".centaur/config.yml": chatConfigText(),
      ".centaur/persona.md": "Be kind.",
    });

    const out = await prepare({ ...deps(), configRoot: trusted.root, env: POSTER_ENV });

    expect(out.claude_args).toContain(TOOLS_RULE);
    await stat(join(stateDir, OIDC_CREDENTIALS_FILE_NAME));
    expect(await read(root, PROMPT_FILE)).toContain(BLOCK);
    expect(JSON.parse(await read(root, MCP_CONFIG_FILE)).mcpServers["centaur-chat"].args).toEqual([
      CHAT_SERVER_ENTRY,
    ]);
  });

  it("does not change a comment turn under the default scope", async () => {
    const { deps, root } = await commentSetup({
      comments: [prComment(1, "rename it")],
      config: configText(),
    });

    const out = await prepare(deps());

    expect(out.claude_args).not.toContain(TOOLS_RULE);
    expect(await read(root, PROMPT_FILE)).not.toContain(BLOCK);
  });
});
