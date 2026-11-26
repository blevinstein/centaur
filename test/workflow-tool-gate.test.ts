import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractToolCalls } from "../src/workflows/finish.js";
import { auditToolCalls } from "../src/workflows/tool-audit.js";
import {
  gateCommand,
  gateToolCall,
  MCP_TOOL_PREFIX,
  toolGateSettings,
} from "../src/workflows/tool-gate.js";
import { connectChatServer, fakeChatClient } from "./helpers/chat-server-fixtures.js";
import {
  executionWithCalls,
  FORBID_DELETE_UNLESS_ALLOWED_ID,
  forbidChatTool,
  GATE_SCRIPTS,
  hookInput,
  runHookCommand,
  runToolGate,
  toolPolicyStateDir,
  writeTempFile,
} from "./helpers/tool-policy-fixtures.js";

const gate = async (policy: string, name: string, input: unknown = {}) =>
  gateToolCall(await toolPolicyStateDir(policy), hookInput(name, input));

describe("gateToolCall", () => {
  it("refuses a forbidden call and leaves the others to allowed_tools", async () => {
    const policy = FORBID_DELETE_UNLESS_ALLOWED_ID;

    expect(await gate(policy, "mcp__linear__delete_issue", { id: "ENG-9" })).toBe(
      "forbidden by policy repo.0",
    );
    expect(await gate(policy, "mcp__linear__delete_issue", { id: "ENG-1" })).toBeUndefined();
    expect(await gate(policy, "mcp__linear__get_issue")).toBeUndefined();
  });

  it("does not check tools outside MCP", async () => {
    expect(await gate(FORBID_DELETE_UNLESS_ALLOWED_ID, "Bash", { command: "ls" })).toBeUndefined();
  });

  it("takes a tool name that holds the separator", async () => {
    const policy = FORBID_DELETE_UNLESS_ALLOWED_ID.replace("delete_issue", "delete__issue");

    expect(await gate(policy, "mcp__linear__delete__issue")).toMatch(/forbidden/);
  });

  it.each(["mcp__linear", "mcp__linear__", "mcp____tool"])(
    "refuses the unparseable name %s",
    async (name) => {
      expect(await gate("", name)).toMatch(/cannot parse the MCP tool name/);
    },
  );

  it.each(["", "not json", "[]", JSON.stringify({ tool_input: {} })])(
    "refuses the input %j",
    async (raw) => {
      expect(await gateToolCall(await toolPolicyStateDir(""), raw)).toMatch(
        /^cannot check the operator policy/,
      );
    },
  );

  it("refuses when the saved policy is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "centaur-gate-"));

    expect(await gateToolCall(empty, hookInput("mcp__linear__get_issue"))).toMatch(
      /^cannot check the operator policy/,
    );
  });

  describe("on the chat server's tools", async () => {
    const chat = await connectChatServer(fakeChatClient().client);
    const tools = (await chat.mcp.listTools()).tools.map(({ name }) => name);

    it("lists the tools the chat server registers", () => {
      expect(tools).toEqual(
        expect.arrayContaining(["list_threads", "read_thread", "read_channel"]),
      );
    });

    it("refuses each of them under a server-wide forbid", async () => {
      for (const tool of tools) {
        expect(await gate(forbidChatTool(), `${MCP_TOOL_PREFIX}centaur-chat__${tool}`)).toMatch(
          /forbidden by policy repo\.0/,
        );
      }
    });

    it("refuses only the tool a forbid names", async () => {
      const policy = forbidChatTool("read_channel");

      expect(await gate(policy, "mcp__centaur-chat__read_channel")).toMatch(/forbidden/);
      expect(await gate(policy, "mcp__centaur-chat__read_thread")).toBeUndefined();
    });
  });
});

describe("the tool-gate command", () => {
  it("exits 0 with nothing on stdout when the call is allowed", async () => {
    const stateDir = await toolPolicyStateDir(FORBID_DELETE_UNLESS_ALLOWED_ID);

    expect(await runToolGate(stateDir, hookInput("mcp__linear__get_issue"))).toEqual({
      exitCode: undefined,
      stderr: "",
      stdout: 0,
    });
  });

  it("exits 2 with the reason on stderr when the call is refused", async () => {
    const stateDir = await toolPolicyStateDir(FORBID_DELETE_UNLESS_ALLOWED_ID);

    expect(await runToolGate(stateDir, hookInput("mcp__linear__delete_issue"))).toEqual({
      exitCode: 2,
      stderr: "Refused by the operator policy: forbidden by policy repo.0\n",
      stdout: 0,
    });
  });

  it("exits 2 when there is no saved policy or the input is junk", async () => {
    const empty = await mkdtemp(join(tmpdir(), "centaur-gate-"));

    for (const [dir, input] of [
      [empty, hookInput("mcp__linear__get_issue")],
      [await toolPolicyStateDir(""), "junk"],
    ] as const) {
      const result = await runToolGate(dir, input);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/^Refused by the operator policy: cannot check/);
    }
  });
});

describe("the hook command", () => {
  const command = async (script: string | undefined) => {
    const entry =
      script === undefined ? "/nonexistent/cli.js" : await writeTempFile("cli.js", script);
    return gateCommand(entry, "/state dir");
  };

  it.each<[string, string | undefined]>([
    ["a missing script", undefined],
    ["a script that crashes", GATE_SCRIPTS.crashes],
    ["a script that prints", GATE_SCRIPTS.prints],
  ])("exits 2 for %s", async (_name, script) => {
    const result = runHookCommand(await command(script), hookInput("mcp__linear__get_issue"));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("passes a deny and its reason through", async () => {
    const result = runHookCommand(await command(GATE_SCRIPTS.denies), "{}");

    expect(result).toMatchObject({ status: 2, stdout: "", stderr: expect.stringContaining("no") });
  });

  it("exits 0 with empty stdout for an allow", async () => {
    expect(runHookCommand(await command(GATE_SCRIPTS.allows), "{}")).toMatchObject({
      status: 0,
      stdout: "",
    });
  });

  it("runs the entry with the state dir and the hook input on stdin", async () => {
    const entry = await writeTempFile(
      "cli.js",
      'let input = ""; process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => { if (process.argv.slice(2).join(" ") !== "tool-gate --state-dir /state dir" || input !== "payload") process.exitCode = 3; });',
    );

    expect(runHookCommand(gateCommand(entry, "/state dir"), "payload").status).toBe(0);
  });
});

describe("toolGateSettings", () => {
  const [hook] = toolGateSettings("/state").hooks.PreToolUse;

  it("matches MCP tools only", () => {
    const matcher = new RegExp(`^(?:${hook?.matcher})$`);

    expect(matcher.test("mcp__linear__get_issue")).toBe(true);
    expect(matcher.test("Bash")).toBe(false);
  });

  it("sets a short explicit timeout and blocks when the hook itself fails", () => {
    expect(hook?.hooks[0]?.timeout).toBeLessThanOrEqual(30);
    expect(hook?.hooks[0]?.onFailure).toBe("block");
  });

  it("runs a command that fails closed", async () => {
    const [entry] = toolGateSettings("/state", "/nonexistent/cli.js").hooks.PreToolUse;

    expect(runHookCommand(entry?.hooks[0]?.command ?? "", "{}").status).toBe(2);
  });
});

describe("auditToolCalls", () => {
  const audit = async (policy: string, calls: Parameters<typeof executionWithCalls>[0]) =>
    auditToolCalls(
      await toolPolicyStateDir(policy),
      await writeTempFile("execution.json", executionWithCalls(calls)),
    );

  it("passes a transcript whose calls the policy allows", async () => {
    await expect(
      audit(FORBID_DELETE_UNLESS_ALLOWED_ID, [
        { name: "mcp__linear__delete_issue", input: { id: "ENG-1" } },
        { name: "mcp__linear__get_issue" },
        { name: "Bash", input: { command: "ls" } },
      ]),
    ).resolves.toBeUndefined();
  });

  it("fails naming each call the policy would have refused", async () => {
    await expect(
      audit(FORBID_DELETE_UNLESS_ALLOWED_ID, [
        { name: "mcp__linear__get_issue" },
        { name: "mcp__linear__delete_issue", input: { id: "ENG-9" } },
      ]),
    ).rejects.toThrow(/mcp__linear__delete_issue: forbidden by policy repo\.0/);
  });

  it("does not name a call the policy allows", async () => {
    await expect(
      audit(FORBID_DELETE_UNLESS_ALLOWED_ID, [
        { name: "mcp__linear__get_issue" },
        { name: "mcp__linear__delete_issue" },
      ]),
    ).rejects.not.toThrow(/get_issue/);
  });

  it("has nothing to audit without a saved policy", async () => {
    const empty = await mkdtemp(join(tmpdir(), "centaur-gate-"));
    const execution = await writeTempFile(
      "execution.json",
      executionWithCalls([{ name: "mcp__linear__delete_issue" }]),
    );

    await expect(auditToolCalls(empty, execution)).resolves.toBeUndefined();
  });

  it("fails when the execution file cannot be read", async () => {
    await expect(
      auditToolCalls(await toolPolicyStateDir(""), "/nonexistent/execution.json"),
    ).rejects.toThrow();
  });
});

describe("extractToolCalls", () => {
  it("lists the tool_use blocks in order and skips other entries", () => {
    expect(
      extractToolCalls(
        executionWithCalls([{ name: "Read", input: { path: "a" } }, { name: "mcp__s__t" }]),
      ),
    ).toEqual([
      { name: "Read", input: { path: "a" } },
      { name: "mcp__s__t", input: {} },
    ]);
  });
});
