import { PutObjectCommand, paginateListObjectsV2, S3Client } from "@aws-sdk/client-s3";
import type { Attachment, Message } from "chat";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const safeSegment = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, "_");

export const attachmentPrefix = (bot: string, threadId: string) =>
  `attachments/${safeSegment(bot)}/${safeSegment(threadId)}/`;

const messageStem = (messageId: string) => `${safeSegment(messageId)}~`;

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export function createS3ObjectStore(bucket: string, client = new S3Client({})): ObjectStore {
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async list(prefix) {
      const keys: string[] = [];
      for await (const page of paginateListObjectsV2(
        { client },
        { Bucket: bucket, Prefix: prefix },
      )) {
        for (const { Key } of page.Contents ?? []) if (Key) keys.push(Key);
      }
      return keys;
    },
  };
}

export interface AttachmentStore {
  /** Copies a message's images into the object store and returns their keys. */
  save(bot: string, message: Message): Promise<string[]>;
  /** Returns, for a thread, a lookup from message ID to the keys of that message's stored images. */
  forThread(bot: string, threadId: string): Promise<(messageId: string) => string[]>;
}

const imageMimeType = (attachment: Attachment) =>
  attachment.mimeType ?? (attachment.type === "image" ? "image/jpeg" : undefined);

async function readBytes(attachment: Attachment): Promise<Buffer> {
  const data = attachment.data ?? (await attachment.fetchData?.());
  if (data === undefined) throw new Error("attachment has no data");
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data instanceof Blob ? await data.arrayBuffer() : data);
}

export function createAttachmentStore(objects: ObjectStore): AttachmentStore {
  return {
    async save(bot, message) {
      const images = message.attachments.flatMap((attachment) => {
        const mimeType = imageMimeType(attachment);
        const extension = mimeType && IMAGE_EXTENSIONS[mimeType];
        return mimeType && extension ? [{ attachment, mimeType, extension }] : [];
      });
      const prefix = attachmentPrefix(bot, message.threadId);
      return Promise.all(
        images.map(async ({ attachment, mimeType, extension }, index) => {
          if ((attachment.size ?? 0) > MAX_ATTACHMENT_BYTES) {
            throw new Error(`attachment is larger than ${MAX_ATTACHMENT_BYTES} bytes`);
          }
          const body = await readBytes(attachment);
          if (body.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`attachment is larger than ${MAX_ATTACHMENT_BYTES} bytes`);
          }
          const key = `${prefix}${messageStem(message.id)}${index}.${extension}`;
          await objects.put(key, body, mimeType);
          return key;
        }),
      );
    },
    async forThread(bot, threadId) {
      const prefix = attachmentPrefix(bot, threadId);
      const keys = (await objects.list(prefix)).sort();
      return (messageId) =>
        keys.filter((key) => key.slice(prefix.length).startsWith(messageStem(messageId)));
    },
  };
}
