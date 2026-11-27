import type { Message } from "chat";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentPrefix,
  createAttachmentStore,
  MAX_ATTACHMENT_BYTES,
  type ObjectStore,
} from "../src/lambda/attachments.js";
import { fakeMessage } from "./helpers/receiver-fixtures.js";

const PHOTO_BYTES = Buffer.from("jpeg-bytes");
const THREAD = "telegram:-100500:7";

const photo = (overrides: Record<string, unknown> = {}) => ({
  type: "image",
  mimeType: "image/jpeg",
  fetchData: async () => PHOTO_BYTES,
  ...overrides,
});

const PDF_BYTES = Buffer.from("%PDF-1.7 recipe");

const pdf = (overrides: Record<string, unknown> = {}) => ({
  type: "file",
  mimeType: "application/pdf",
  name: "recipe.pdf",
  fetchData: async () => PDF_BYTES,
  ...overrides,
});

const messageWith = (...attachments: unknown[]) =>
  ({ ...fakeMessage({ attachments }), threadId: THREAD }) as unknown as Message;

function setup() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const store: ObjectStore = {
    put: vi.fn(async (key, body, contentType) => {
      objects.set(key, { body, contentType });
    }),
    list: vi.fn(async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix))),
  };
  return { objects, store, attachments: createAttachmentStore(store) };
}

describe("attachment store", () => {
  it("stores each image under the bot and thread, keyed by message and index", async () => {
    const { objects, attachments } = setup();

    const saved = await attachments.save(
      "garden",
      messageWith(photo(), photo({ mimeType: "image/png" })),
    );

    expect(saved).toEqual([...objects.keys()]);
    expect([...objects.keys()]).toEqual([
      `${attachmentPrefix("garden", THREAD)}telegram_msg-42~0.jpg`,
      `${attachmentPrefix("garden", THREAD)}telegram_msg-42~1.png`,
    ]);
    expect([...objects.values()].map((o) => o.contentType)).toEqual(["image/jpeg", "image/png"]);
    expect(objects.values().next().value?.body).toEqual(PHOTO_BYTES);
  });

  it("treats a photo with no mime type as a JPEG and accepts image files", async () => {
    const { objects, attachments } = setup();

    await attachments.save(
      "garden",
      messageWith(photo({ mimeType: undefined }), photo({ type: "file", mimeType: "image/webp" })),
    );

    expect([...objects.keys()].map((key) => key.split("~")[1])).toEqual(["0.jpg", "1.webp"]);
  });

  it("stores a PDF next to images", async () => {
    const { objects, attachments } = setup();

    await attachments.save("garden", messageWith(photo(), pdf()));

    expect([...objects.keys()].map((key) => key.split("~")[1])).toEqual(["0.jpg", "1.pdf"]);
    expect([...objects.values()][1]).toEqual({ body: PDF_BYTES, contentType: "application/pdf" });
  });

  it("drops a file named .pdf whose bytes are not a PDF", async () => {
    const { objects, attachments } = setup();

    const saved = await attachments.save(
      "garden",
      messageWith(pdf({ fetchData: async () => Buffer.from("MZ\x90 not a pdf") })),
    );

    expect(saved).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it.each([
    ["a video", { type: "video", mimeType: "video/mp4" }],
    ["a Word document", { type: "file", mimeType: "application/msword", name: "recipe.doc" }],
    ["a PDF named like another type", { ...pdf(), name: "recipe.exe" }],
    ["an unreadable image format", { type: "image", mimeType: "image/heic" }],
  ])("ignores %s", async (_name, attachment) => {
    const { objects, attachments } = setup();

    await attachments.save("garden", messageWith(photo(attachment)));

    expect(objects.size).toBe(0);
  });

  it("reads bytes from inline data when there is no fetcher", async () => {
    const { objects, attachments } = setup();

    await attachments.save(
      "garden",
      messageWith({ type: "image", mimeType: "image/png", data: new Blob([PHOTO_BYTES]) }),
    );

    expect([...objects.values()][0]?.body).toEqual(PHOTO_BYTES);
  });

  it.each([
    ["declares a size over the limit", photo({ size: MAX_ATTACHMENT_BYTES + 1 })],
    [
      "downloads more bytes than the limit",
      photo({ fetchData: async () => Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }),
    ],
    ["is a PDF over the limit", pdf({ size: MAX_ATTACHMENT_BYTES + 1 })],
    ["has no data", { type: "image", mimeType: "image/png" }],
    [
      "fails to download",
      photo({
        fetchData: async () => {
          throw new Error("telegram down");
        },
      }),
    ],
  ])("rejects an image that %s, storing nothing", async (_name, attachment) => {
    const { objects, attachments } = setup();

    await expect(attachments.save("garden", messageWith(attachment))).rejects.toThrow();

    expect(objects.size).toBe(0);
  });

  it("looks up a thread's stored images by message, without confusing similar IDs", async () => {
    const { attachments } = setup();
    await attachments.save("garden", messageWith(photo()));
    await attachments.save("garden", {
      ...messageWith(photo()),
      id: "telegram:msg-42-1",
    } as Message);
    await attachments.save("other", messageWith(photo()));

    const lookup = await attachments.forThread("garden", THREAD);

    expect(lookup("telegram:msg-42")).toEqual([
      `${attachmentPrefix("garden", THREAD)}telegram_msg-42~0.jpg`,
    ]);
    expect(lookup("telegram:msg-42-1")).toHaveLength(1);
    expect(lookup("telegram:msg-4")).toEqual([]);
  });
});
