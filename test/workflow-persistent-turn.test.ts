import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readTurnState } from "../src/workflows/turn-state.js";
import {
  BOUND_THREAD,
  EARLIER_RUN,
  letters,
  operationsOf,
  PERSISTENT_FAN_OUT_CONFIG,
  PRIMARY_THREAD,
  persistentConfig,
  prefixOf,
  prepareScheduled,
  RESOLVE_PERSISTENT,
  readPrompt,
  runFanOut,
  scheduledSetup,
  sizedMessages,
  startFinish,
  startThreadRequests,
} from "./helpers/turn-fixtures.js";
import { botMessage, configText, message } from "./helpers/workflow-fixtures.js";

describe("a scheduled prompt with thread: persistent", () => {
  describe("before the destination has a thread", () => {
    it("asks for the bound thread, reads nothing and starts with an empty history", async () => {
      const run = await scheduledSetup(EARLIER_RUN, persistentConfig(", context: resume"));
      await prepareScheduled(run);

      expect(run.aws.requests).toEqual([RESOLVE_PERSISTENT]);
      expect(await readPrompt(run.root)).not.toContain("Earlier messages");
      expect(await readTurnState(run.stateDir)).toMatchObject({
        policy: "resume",
        start: [{ destination: "household", platform: "telegram", thread: "persistent" }],
      });
    });

    it("starts the persistent thread and saves the session under the thread it returns", async () => {
      const run = await scheduledSetup([], persistentConfig(", context: resume"));
      await prepareScheduled(run);
      const { sessionDirectory } = await readTurnState(run.stateDir);
      await writeFile(`${sessionDirectory}/s2.jsonl`, "data");

      await startFinish(run, { session_id: "s2", structured_output: { reply: "Tasks" } });

      expect(startThreadRequests(run.aws)[0]).toEqual({
        operation: "start-thread",
        bot: "sprout",
        text: "Tasks",
        destination: "household",
        platform: "telegram",
        thread: "persistent",
        context: "resume",
      });
      expect(run.aws.objects.get(`${prefixOf(PRIMARY_THREAD)}s2.jsonl`)).toBe("data");
    });
  });

  describe("once the destination has a thread", () => {
    it("shows the earlier run and the replies after the marker as pending", async () => {
      const run = await scheduledSetup(
        EARLIER_RUN,
        persistentConfig(", context: transcript"),
        BOUND_THREAD,
      );
      await run.aws.storeFor("sprout", BOUND_THREAD).writeMarker("2");
      await prepareScheduled(run);

      const text = await readPrompt(run.root);
      expect(operationsOf(run.aws)).toContain("read");
      expect(run.aws.requests.find((r) => r.operation === "read")).toMatchObject({
        threadId: BOUND_THREAD,
      });
      expect(text).toContain("# Earlier messages in this thread");
      expect(text.indexOf("first question")).toBeLessThan(text.indexOf("# New messages to answer"));
      expect(text.indexOf("please add rain")).toBeGreaterThan(text.indexOf("# New messages"));
      expect(await readTurnState(run.stateDir)).toMatchObject({
        marker: "3",
        markerThreadId: BOUND_THREAD,
      });
    });

    it("advances the marker in the thread it posted to", async () => {
      const run = await scheduledSetup(EARLIER_RUN, persistentConfig(), BOUND_THREAD);
      await prepareScheduled(run);
      await startFinish(run);

      expect(run.aws.objects.get(`${prefixOf(BOUND_THREAD)}last-processed`)).toBe("3");
    });

    it("leaves the marker alone when the run posted to a different thread", async () => {
      const run = await scheduledSetup(
        EARLIER_RUN,
        persistentConfig(),
        BOUND_THREAD,
        PRIMARY_THREAD,
      );
      await prepareScheduled(run);
      await startFinish(run);

      expect(run.aws.objects.has(`${prefixOf(PRIMARY_THREAD)}last-processed`)).toBe(false);
      expect(run.aws.objects.has(`${prefixOf(BOUND_THREAD)}last-processed`)).toBe(false);
    });

    it("fits the earlier messages into the transcript budget and notes the omission", async () => {
      const run = await scheduledSetup(
        [...sizedMessages([30, 30, 30, 30]), message("5", "pending")],
        persistentConfig(", context: transcript", "context: { transcript_max_chars: 100 }"),
        BOUND_THREAD,
      );
      await run.aws.storeFor("sprout", BOUND_THREAD).writeMarker("4");
      await prepareScheduled(run);

      const text = await readPrompt(run.root);
      expect(text).toContain(letters(3, 30));
      expect(text).not.toContain(letters(0, 30));
      expect(text).toContain("1 earlier message in this thread is omitted");
    });

    it("resumes the saved session instead of showing the transcript", async () => {
      const run = await scheduledSetup(
        EARLIER_RUN,
        persistentConfig(", context: resume"),
        BOUND_THREAD,
      );
      run.aws.objects.set(`${prefixOf(BOUND_THREAD)}s1.jsonl`, "session");
      const out = await prepareScheduled(run);

      expect(out.claude_args).toContain("--resume s1");
      expect(await readPrompt(run.root)).not.toContain("# Earlier messages");
    });

    it("falls back to the transcript when a resume prompt has no saved session", async () => {
      const run = await scheduledSetup(
        EARLIER_RUN,
        persistentConfig(", context: resume"),
        BOUND_THREAD,
      );
      const out = await prepareScheduled(run);

      expect(out.claude_args).not.toContain("--resume");
      expect(await readPrompt(run.root)).toContain("# Earlier messages");
    });
  });

  describe("the context policy", () => {
    it("is the prompt's own, and a fresh prompt shows only the pending replies", async () => {
      const run = await scheduledSetup(
        EARLIER_RUN,
        persistentConfig(", context: fresh"),
        BOUND_THREAD,
      );
      await prepareScheduled(run);

      const text = await readPrompt(run.root);
      expect(text).not.toContain("# Earlier messages");
      expect(text).toContain("please add rain");
      expect(text).not.toContain("first question");
      expect((await readTurnState(run.stateDir)).policy).toBe("fresh");
    });

    it("yields to the latest /transcript in the thread, which start-thread then stores", async () => {
      const run = await scheduledSetup(
        [message("1", "/transcript"), botMessage("2", "ok"), message("3", "more")],
        persistentConfig(", context: fresh"),
        BOUND_THREAD,
      );
      await run.aws.storeFor("sprout", BOUND_THREAD).writeMarker("2");
      await prepareScheduled(run);
      await startFinish(run);

      expect(await readPrompt(run.root)).toContain("# Earlier messages");
      expect(startThreadRequests(run.aws)[0]).toMatchObject({ context: "transcript" });
    });
  });

  describe("with several targets", () => {
    it("starts a persistent thread on every platform and reads only the first target's", async () => {
      const run = await runFanOut([], PERSISTENT_FAN_OUT_CONFIG);
      await run.finishing;

      expect(operationsOf(run.aws)).toEqual([
        "resolve-destination",
        "start-thread",
        "start-thread",
        "link-pull-request",
      ]);
      expect(run.aws.requests[0]).toMatchObject({ platform: "telegram", name: "household" });
      expect(run.aws.requests.slice(1, 3)).toEqual([
        expect.objectContaining({ platform: "telegram", thread: "persistent" }),
        expect.objectContaining({ platform: "slack", thread: "persistent" }),
      ]);
    });
  });

  describe("a prompt with thread: new", () => {
    it("never resolves a destination and never sends thread", async () => {
      const run = await scheduledSetup(
        [],
        configText("prompts: {weekly: {destination: household, thread: new}}"),
      );
      await prepareScheduled(run);
      await startFinish(run);

      expect(operationsOf(run.aws)).not.toContain("resolve-destination");
      expect(run.aws.requests[0]).not.toHaveProperty("thread");
      expect((await readTurnState(run.stateDir)).start).toEqual([
        { destination: "household", platform: "telegram" },
      ]);
    });
  });
});
