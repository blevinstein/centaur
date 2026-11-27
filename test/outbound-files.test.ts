import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOUND_FILES_MAX } from "../src/poster-contract.js";
import { finish } from "../src/workflows/finish.js";
import { readOutboundFiles } from "../src/workflows/outbound-files.js";
import { prepare } from "../src/workflows/prepare.js";
import { replySchema } from "../src/workflows/prompt.js";
import {
  base64,
  linkOutboundFiles,
  OPT_IN,
  OUTBOUND_FILES,
  outboundWorkspace,
  PNG,
} from "./helpers/outbound-fixtures.js";
import { posterSetup } from "./helpers/poster-fixtures.js";
import { setup } from "./helpers/turn-fixtures.js";
import { configText, message, schemaOptions } from "./helpers/workflow-fixtures.js";

describe("readOutboundFiles", () => {
  it("reads a workspace file, including one reached through an inside symlink", async () => {
    const root = await outboundWorkspace();

    expect(await readOutboundFiles(root, ["chart.png", "out/notes.txt", "alias.png"])).toEqual({
      files: [
        { filename: "chart.png", data: base64(PNG) },
        { filename: "notes.txt", data: base64("notes") },
        { filename: "chart.png", data: base64(PNG) },
      ],
      skipped: 0,
    });
  });

  it.each([
    ["a parent path", "../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["a symlink out of the workspace", "escape.txt"],
    ["a symlink to a hidden file", "env-link.txt"],
    ["a dotfile", ".env"],
    ["the git directory", ".git/config"],
    ["the turn directory", ".centaur-turn/prompt.md"],
    ["a path that leaves and returns", "out/../.env"],
    ["a directory", "out"],
    ["a missing file", "nope.png"],
    ["an empty file", "empty.txt"],
    ["a file over the size limit", "big.bin"],
  ])("skips %s", async (_name, path) => {
    expect(await readOutboundFiles(await outboundWorkspace(), [path])).toEqual({
      files: [],
      skipped: 1,
    });
  });

  it("keeps the files within the count and the total size", async () => {
    const root = await outboundWorkspace();

    const counted = await readOutboundFiles(root, Array(OUTBOUND_FILES_MAX + 1).fill("chart.png"));
    expect(counted.files).toHaveLength(OUTBOUND_FILES_MAX);
    expect(counted.skipped).toBe(1);

    const heavy = await readOutboundFiles(root, ["half-a.bin", "half-b.bin", "chart.png"]);
    expect(heavy.files.map(({ filename }) => filename)).toEqual(["half-a.bin", "chart.png"]);
    expect(heavy.skipped).toBe(1);
  });
});

describe("outbound files in a turn", () => {
  afterEach(() => vi.restoreAllMocks());

  const finishWith = async (config: string, files: string[]) => {
    const run = await setup([message("1", "draw")], config, OUTBOUND_FILES);
    await linkOutboundFiles(run.root);
    const prepared = await prepare(run.deps());
    await run.writeExecution({ structured_output: { reply: "Here.", files } });
    await finish({
      stateDir: run.stateDir,
      workspace: run.root,
      executionFile: run.executionFile,
      poster: run.aws.poster,
      storeFor: run.aws.storeFor,
    });
    return { run, prepared };
  };

  it("offers the field and posts the files when the config opts in", async () => {
    const { run, prepared } = await finishWith(configText(OPT_IN), ["chart.png"]);

    expect(prepared.claude_args).toContain('"files"');
    expect(run.aws.requests.find((r) => r.operation === "post")).toMatchObject({
      text: "Here.",
      files: [{ filename: "chart.png", data: base64(PNG) }],
    });
  });

  it("neither offers the field nor posts files without the opt-in", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run, prepared } = await finishWith(configText(), ["chart.png"]);

    expect(prepared.claude_args).not.toContain('"files"');
    expect(run.aws.requests.find((r) => r.operation === "post")).not.toHaveProperty("files");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignoring files"));
  });

  it("tells the thread when a named file could not be attached", async () => {
    const { run } = await finishWith(configText(OPT_IN), ["chart.png", ".env"]);

    const post = run.aws.requests.find((r) => r.operation === "post");
    expect(post).toMatchObject({ text: expect.stringContaining("1 of the files") });
    expect(post).toMatchObject({ files: [{ filename: "chart.png" }] });
  });
});

describe("replySchema files", () => {
  it("is offered to a chat reply turn only", () => {
    expect(replySchema(schemaOptions({ outboundFiles: true })).properties).toHaveProperty("files");
    expect(replySchema(schemaOptions()).properties).not.toHaveProperty("files");
    expect(
      replySchema(schemaOptions({ outboundFiles: true, mode: "comment" })).properties,
    ).not.toHaveProperty("files");
  });
});

describe("poster post with files", () => {
  const POST = { operation: "post", bot: "garden", threadId: "telegram:-100500:77", text: "hi" };

  it("uploads the decoded files with the text", async () => {
    const { poster, thread } = await posterSetup();

    await poster({ ...POST, files: [{ filename: "chart.png", data: base64(PNG) }] });

    expect(thread.post.mock.calls).toEqual([
      ["hi"],
      [{ raw: "", files: [{ filename: "chart.png", data: Buffer.from(PNG) }] }],
    ]);
  });

  it.each([
    ["a path in the name", { filename: "a/b.png", data: base64(PNG) }],
    ["a hidden name", { filename: ".env", data: base64(PNG) }],
    ["data that is not base64", { filename: "a.png", data: "***" }],
    ["an extra key", { filename: "a.png", data: base64(PNG), path: "/etc" }],
    ["an oversized file", { filename: "a.png", data: "A".repeat(4 * 1024 * 1024 + 4) }],
  ])("rejects %s", async (_name, file) => {
    const { poster, thread } = await posterSetup();

    await expect(poster({ ...POST, files: [file] })).rejects.toThrow();
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("rejects too many files and too many bytes in total", async () => {
    const { poster } = await posterSetup();
    const file = { filename: "a.png", data: base64(PNG) };
    const bulky = { filename: "b.png", data: "A".repeat(2 * 1024 * 1024) };

    await expect(
      poster({ ...POST, files: Array(OUTBOUND_FILES_MAX + 1).fill(file) }),
    ).rejects.toThrow();
    await expect(poster({ ...POST, files: [bulky, bulky, bulky] })).rejects.toThrow();
  });
});
