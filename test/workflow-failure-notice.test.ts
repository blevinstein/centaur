import { describe, expect, it, vi } from "vitest";
import { finish, notifyFailure } from "../src/workflows/finish.js";
import { prepare } from "../src/workflows/prepare.js";
import { REPLY_MARKER } from "../src/workflows/resolve.js";
import { readTurnState } from "../src/workflows/turn-state.js";
import { failingStore, setup } from "./helpers/turn-fixtures.js";
import { configText, message, THREAD } from "./helpers/workflow-fixtures.js";

const RUN_URL = "https://example.test/run/1";
const payload = { bot: "sprout", thread_id: THREAD, message_id: "1" };

const operations = (aws: { requests: { operation: string }[] }, operation: string) =>
  aws.requests.filter((request) => request.operation === operation);

describe("notifyFailure without turn state", () => {
  it("answers the thread named by the dispatch payload and clears the triggering reaction", async () => {
    const { aws, stateDir } = await setup([message("1", "hi")]);

    await notifyFailure({ stateDir, poster: aws.poster, runUrl: RUN_URL, clientPayload: payload });

    expect(aws.requests).toEqual([
      {
        operation: "post",
        bot: "sprout",
        threadId: THREAD,
        text: `That turn did not finish. Details are in the workflow run: ${RUN_URL}`,
      },
      { operation: "unreact", bot: "sprout", threadId: THREAD, messageIds: ["1"] },
    ]);
  });

  it.each([
    ["no payload", undefined],
    ["a scheduled event's missing payload", {}],
    ["a malformed payload", { bot: "sprout" }],
  ])("stays silent with %s", async (_name, clientPayload) => {
    const { aws, stateDir } = await setup([message("1", "hi")]);
    await notifyFailure({ stateDir, poster: aws.poster, runUrl: RUN_URL, clientPayload });
    expect(aws.requests).toEqual([]);
  });

  it("comments on the pull request of a comment turn that failed in prepare", async () => {
    const { aws, stateDir } = await setup([message("1", "hi")]);
    const comment = vi.fn(async () => undefined);

    await notifyFailure({
      stateDir,
      poster: aws.poster,
      runUrl: RUN_URL,
      pullRequest: 9,
      comment: { repository: "octo/sprout", github: { comment } as never },
    });

    expect(comment).toHaveBeenCalledWith(
      "octo/sprout",
      9,
      `${REPLY_MARKER}\nThat turn did not finish. Details are in the workflow run: ${RUN_URL}`,
      undefined,
    );
    expect(aws.requests).toEqual([]);
  });

  it("prefers the turn state to the payload", async () => {
    const { deps, aws, stateDir } = await setup([message("1", "hi"), message("2", "again")]);
    await prepare(deps());
    await notifyFailure({
      stateDir,
      poster: aws.poster,
      runUrl: RUN_URL,
      clientPayload: { ...payload, thread_id: "telegram:-100:other" },
    });
    expect(operations(aws, "post").at(-1)).toMatchObject({
      threadId: THREAD,
      text: expect.stringContaining("That turn failed"),
    });
  });
});

describe("finish failing after the reply", () => {
  const replyOnce = async (options: {
    failing: "writeMarker" | "saveSession";
    config?: string;
  }) => {
    const turn = await setup([message("1", "hi")], configText(options.config));
    await prepare(turn.deps());
    await turn.writeExecution({ structured_output: { reply: "Hello." }, session_id: "s1" });
    const run = () =>
      finish({
        stateDir: turn.stateDir,
        executionFile: turn.executionFile,
        poster: turn.aws.poster,
        storeFor: failingStore(turn.aws.storeFor, options.failing),
      });
    return { ...turn, run };
  };

  it("fails the step when the marker cannot be written, after posting the reply once", async () => {
    const turn = await replyOnce({ failing: "writeMarker" });

    await expect(turn.run()).rejects.toThrow("s3 down");

    expect(operations(turn.aws, "post")).toHaveLength(1);
    expect((await readTurnState(turn.stateDir)).replied).toBe(true);
    await notifyFailure({
      stateDir: turn.stateDir,
      poster: turn.aws.poster,
      runUrl: RUN_URL,
    });
    expect(operations(turn.aws, "post").at(-1)).toMatchObject({
      text: expect.stringContaining("I replied, but could not finish recording"),
    });
    expect(operations(turn.aws, "unreact")).toHaveLength(1);
  });

  it("warns and finishes when only the session cannot be saved", async () => {
    const turn = await replyOnce({ failing: "saveSession", config: "context:\n  default: resume" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await turn.run();

    expect(warn).toHaveBeenCalledWith("::warning::could not save the session (Error)");
    expect(operations(turn.aws, "post")).toHaveLength(1);
    expect(operations(turn.aws, "unreact")).toHaveLength(1);
    warn.mockRestore();
  });
});
