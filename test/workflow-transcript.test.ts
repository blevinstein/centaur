import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/workflows/commands.js";
import { buildPrompt, replySchema } from "../src/workflows/prompt.js";
import { pendingMessages, planTurn, threadPolicy } from "../src/workflows/transcript.js";
import { botMessage, message } from "./helpers/workflow-fixtures.js";

describe("parseCommand", () => {
  it.each([
    ["/new", "new", ""],
    ["/NEW fix the beds", "new", "fix the beds"],
    ["/resume@sprout_bot  keep going", "resume", "keep going"],
    ["/transcript", "transcript", ""],
    ["  /resume\nmore detail", "resume", "more detail"],
  ])("parses %j", (text, command, rest) => {
    expect(parseCommand(text)).toEqual({ command, text: rest });
  });

  it.each(["hello /new", "/newer", "/resumed", "/other cmd", ""])("ignores %j", (text) => {
    expect(parseCommand(text).command).toBeUndefined();
  });
});

describe("pendingMessages", () => {
  const thread = [message("1", "a"), botMessage("2", "r"), message("3", "b"), message("4", "c")];

  it("starts after the marker when present", () => {
    expect(pendingMessages(thread, "3").map((m) => m.id)).toEqual(["4"]);
  });

  it("keeps messages that arrived during a turn, because the marker precedes the bot reply", () => {
    const racing = [message("1", "a"), message("2", "b"), botMessage("3", "r")];
    expect(pendingMessages([...racing, message("4", "c")], "1").map((m) => m.id)).toEqual([
      "2",
      "4",
    ]);
  });

  it("falls back to the bot's last message without a marker or with an expired one", () => {
    expect(pendingMessages(thread, undefined).map((m) => m.id)).toEqual(["3", "4"]);
    expect(pendingMessages(thread, "gone").map((m) => m.id)).toEqual(["3", "4"]);
  });
});

describe("threadPolicy", () => {
  it("uses the latest policy command from a human and ignores bot text", () => {
    const messages = [message("1", "/resume"), botMessage("2", "/transcript"), message("3", "hi")];
    expect(threadPolicy(messages, "transcript")).toBe("resume");
    expect(threadPolicy([...messages, message("4", "/transcript")], "resume")).toBe("transcript");
    expect(threadPolicy([message("1", "hi")], "fresh")).toBe("fresh");
  });
});

describe("planTurn", () => {
  const plan = (messages: ReturnType<typeof message>[], marker?: string) =>
    planTurn({ messages, marker, defaultPolicy: "transcript" });

  it("skips when nothing is pending", () => {
    expect(plan([message("1", "a"), botMessage("2", "r")])).toEqual({ kind: "skip" });
  });

  it("replies to every pending message with commands stripped", () => {
    const result = plan([message("1", "/resume what now"), message("2", "and more")]);
    expect(result).toMatchObject({ kind: "reply", policy: "resume" });
    expect(result.kind === "reply" && result.pending.map((m) => m.text)).toEqual([
      "what now",
      "and more",
    ]);
  });

  it("replies to a message that is only an attachment", () => {
    const result = plan([message("1", "", { attachments: ["attachments/b/t/1~0.jpg"] })]);
    expect(result).toMatchObject({ kind: "reply" });
  });

  it("acknowledges a bare policy command", () => {
    expect(plan([message("1", "/transcript")])).toEqual({ kind: "ack", policy: "transcript" });
  });

  it("starts a new thread seeded from the /new message onward", () => {
    const result = plan([
      message("1", "old"),
      message("2", "/new fresh idea"),
      message("3", "more"),
    ]);
    expect(result.kind === "new-thread" && result.seed.map((m) => m.text)).toEqual([
      "fresh idea",
      "more",
    ]);
    expect(plan([message("1", "/new")])).toEqual({ kind: "new-thread", seed: [] });
  });
});

describe("buildPrompt", () => {
  it("renders instructions, the scheduled task, history and new messages", () => {
    const prompt = buildPrompt({
      scheduledTask: "Weekly tasks",
      history: [botMessage("1", "earlier")],
      messages: [message("2", "now")],
    });
    expect(prompt).toContain("# Scheduled task\n\nWeekly tasks");
    expect(prompt).toContain("assistant: earlier");
    expect(prompt).toContain("# New messages to answer\n\n[2026-11-17T10:00:02.000Z] Sam: now");
  });

  it("tells the agent it may stay silent only when it can", () => {
    const messages = [message("1", "lunch?")];
    expect(buildPrompt({ messages })).not.toContain("stay silent");
    const prompt = buildPrompt({ messages, canStaySilent: true });
    expect(prompt).toContain("not necessarily\naddressed to you");
    expect(prompt).toContain("Reply when a message mentions you");
    expect(prompt).toContain('set "ignore" to true');
    expect(prompt).not.toContain("@");
    expect(buildPrompt({ messages, canStaySilent: true, handle: "garden_bot" })).toContain(
      "People mention you as @garden_bot.",
    );
  });

  it("requires a reply unless silence is allowed", () => {
    expect(replySchema(false)).toMatchObject({ required: ["reply"] });
    expect(replySchema(false).properties).not.toHaveProperty("ignore");
    expect(replySchema(true)).toMatchObject({
      required: [],
      properties: { ignore: { type: "boolean" } },
    });
  });

  it("lists loaded images by path for new messages and as not loaded in history", () => {
    const key = "attachments/b/t/1~0.jpg";
    const prompt = buildPrompt({
      history: [message("1", "look", { attachments: [key] })],
      messages: [message("2", "", { attachments: [key] })],
      attachmentPath: (k) => `.centaur-turn/attachments/${k.split("/").at(-1)}`,
    });
    expect(prompt).toContain("Sam: look\n[attached image, not loaded]");
    expect(prompt).toContain("Sam: [attached image: .centaur-turn/attachments/1~0.jpg]");
  });

  it("omits empty sections", () => {
    expect(buildPrompt({ messages: [message("1", "hi")] })).not.toContain("Earlier messages");
  });
});
