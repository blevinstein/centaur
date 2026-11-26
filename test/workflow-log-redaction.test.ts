import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAttachmentDownloader,
  createThreadStore,
  PosterError,
} from "../src/workflows/aws.js";
import { clearReactions } from "../src/workflows/reactions.js";
import { safeDetail } from "../src/workflows/safe-error.js";
import {
  BUCKET_NAME,
  expectNoIds,
  failingS3Exec,
  LEAKY_SLACK_THREAD,
  LEAKY_THREAD,
} from "./helpers/log-redaction-fixtures.js";

const key = `sessions/garden/${LEAKY_THREAD.replaceAll(":", "_")}/last-processed`;
const exec = failingS3Exec(key);

afterEach(() => vi.restoreAllMocks());

describe("runner errors", () => {
  it.each([
    [
      "marker read",
      () => createThreadStore(BUCKET_NAME, "garden", LEAKY_THREAD, exec).readMarker(),
    ],
    [
      "marker write",
      () => createThreadStore(BUCKET_NAME, "garden", LEAKY_THREAD, exec).writeMarker("1"),
    ],
    [
      "session restore",
      () =>
        createThreadStore(BUCKET_NAME, "garden", LEAKY_SLACK_THREAD, exec).restoreSession("/tmp"),
    ],
    [
      "session save",
      () => createThreadStore(BUCKET_NAME, "garden", LEAKY_THREAD, exec).saveSession("/tmp", "abc"),
    ],
    [
      "attachment download",
      () => createAttachmentDownloader(BUCKET_NAME, exec).download(key, "/tmp/x/y"),
    ],
  ])("name no thread, chat or object for a failed %s", async (_name, run) => {
    const error = await run().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PosterError);
    expect((error as Error).message).toMatch(/^aws s3(api)? \w[\w-]* failed: /);
    expectNoIds((error as Error).message);
  });

  it("log only the class of an error that is not a SafeError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poster = {
      call: vi
        .fn()
        .mockRejectedValue(new Error(`no access to ${LEAKY_THREAD} / ${LEAKY_SLACK_THREAD}`)),
    };

    await clearReactions(poster as never, {
      bot: "garden",
      threadId: LEAKY_THREAD,
      messageIds: ["1"],
    });

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("could not clear reactions: Error");
    expectNoIds(logged);
  });

  it("keep the message of a SafeError", () => {
    expect(safeDetail(new PosterError("poster read failed (Error)"))).toBe(
      "poster read failed (Error)",
    );
  });
});
