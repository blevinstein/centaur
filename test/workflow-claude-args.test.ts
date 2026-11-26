import { parse } from "shell-quote";
import { describe, expect, it } from "vitest";
import { parseConfigOrThrow } from "../src/workflows/config-file.js";
import { buildClaudeArgs } from "../src/workflows/prepare.js";
import { replySchema } from "../src/workflows/prompt.js";
import { doubleQuote, shellArg, singleQuote } from "../src/workflows/shell-arg.js";
import { configText, replySchemaCombinations } from "./helpers/workflow-fixtures.js";

const argValue = (args: string, flag: string) => {
  const tokens = parse(args);
  return tokens[tokens.indexOf(flag) + 1];
};

describe("buildClaudeArgs", () => {
  it.each(replySchemaCombinations())("round-trips the reply schema for %j", (options) => {
    const config = parseConfigOrThrow(
      configText(`pull_requests: { comment_new: ${options.allowNewPr} }`),
    );
    const args = buildClaudeArgs({
      config,
      persona: undefined,
      resumeSessionId: undefined,
      canStaySilent: options.canStaySilent,
      mode: options.mode,
      allowExisting: options.allowExisting,
      suspendable: options.suspendable,
    });
    expect(JSON.parse(argValue(args, "--json-schema") as string)).toEqual(
      JSON.parse(JSON.stringify(replySchema(options))),
    );
  });

  it("passes awkward paths and tools through a shell parser unchanged", () => {
    const config = parseConfigOrThrow(
      configText().replace("Read,Edit", 'Read,Bash(echo "$HOME" *)'),
    );
    const args = buildClaudeArgs({
      config,
      persona: "/work dir/it's.md",
      resumeSessionId: undefined,
      canStaySilent: false,
      mode: "reply",
      allowExisting: true,
      mcpConfig: "a b/mcp.json",
    });
    expect(argValue(args, "--append-system-prompt-file")).toBe("/work dir/it's.md");
    expect(argValue(args, "--mcp-config")).toBe("a b/mcp.json");
    expect(argValue(args, "--allowedTools")).toBe('Read,Bash(echo "$HOME" *)');
  });

  const HOSTILE_MODELS = [
    "sonnet --dangerously-skip-permissions",
    "sonnet; rm -rf /",
    "sonnet'--max-turns 999",
    'sonnet" --max-budget-usd 1000',
    "$(id)",
    "-sonnet",
    "",
  ];

  it.each(HOSTILE_MODELS)("the schema rejects the model %j", (model) => {
    expect(() =>
      parseConfigOrThrow(configText().replace("model: sonnet", `model: ${JSON.stringify(model)}`)),
    ).toThrow();
  });

  it.each(["sonnet", "opus[1m]", "claude-opus-4-1-20250805", "us.anthropic.claude-sonnet-4:0"])(
    "the schema accepts the model %j",
    (model) => {
      expect(
        parseConfigOrThrow(configText().replace("model: sonnet", `model: ${model}`)).model,
      ).toBe(model);
    },
  );

  it.each(HOSTILE_MODELS.filter(Boolean))("quotes the model %j as one argument", (model) => {
    const config = { ...parseConfigOrThrow(configText()), model };
    const args = buildClaudeArgs({
      config,
      persona: undefined,
      resumeSessionId: undefined,
      canStaySilent: false,
      mode: "reply",
      allowExisting: true,
    });
    const tokens = parse(args);
    expect(argValue(args, "--model")).toBe(model);
    expect(tokens.filter((token) => typeof token === "string" && token.startsWith("--"))).toEqual([
      "--model",
      "--allowedTools",
      "--max-turns",
      "--json-schema",
    ]);
  });
});

describe("shell quoting", () => {
  const awkward = ["it's", 'say "hi"', "$HOME `x` \\ !", "a b", "", "'", "plain-1.2/x"];

  it.each(awkward)("round-trips %j", (value) => {
    for (const quote of [singleQuote, doubleQuote, shellArg]) {
      expect(parse(`--flag ${quote(value)}`)).toEqual(["--flag", ...(value ? [value] : [""])]);
    }
  });

  it("leaves plain values bare", () => {
    expect(shellArg("/a/b-c.md")).toBe("/a/b-c.md");
  });
});

describe("json schema quoting", () => {
  it("round-trips a description with an apostrophe and a double quote", () => {
    const schema = { properties: { x: { description: `this thread's "own" \\ $HOME` } } };
    expect(parse(`--json-schema ${singleQuote(JSON.stringify(schema))}`)).toEqual([
      "--json-schema",
      JSON.stringify(schema),
    ]);
  });
});
