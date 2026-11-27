import { PutObjectCommand, paginateListObjectsV2, S3Client } from "@aws-sdk/client-s3";
import type { Attachment, Message } from "chat";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const hasPdfHeader = (body: Buffer) => body.subarray(0, 5).toString("latin1") === "%PDF-";

interface StoredType {
  extension: string;
  /** Present for types whose bytes are checked and whose file name must carry the extension. */
  hasValidContent?: (body: Buffer) => boolean;
}

const STORED_TYPES: Record<string, StoredType> = {
  "image/jpeg": { extension: "jpg" },
  "image/png": { extension: "png" },
  "image/gif": { extension: "gif" },
  "image/webp": { extension: "webp" },
  "application/pdf": { extension: "pdf", hasValidContent: hasPdfHeader },
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
  /** Copies a message's images and PDFs into the object store and returns their keys. */
  save(bot: string, message: Message): Promise<string[]>;
  /** Returns, for a thread, a lookup from message ID to the keys of that message's stored files. */
  forThread(bot: string, threadId: string): Promise<(messageId: string) => string[]>;
}

const storedMimeType = (attachment: Attachment) =>
  attachment.mimeType ?? (attachment.type === "image" ? "image/jpeg" : undefined);

const nameHasExtension = (attachment: Attachment, extension: string) =>
  attachment.name === undefined || attachment.name.toLowerCase().endsWith(`.${extension}`);

const assertWithinLimit = (bytes: number) => {
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment is larger than ${MAX_ATTACHMENT_BYTES} bytes`);
  }
};

async function readBytes(attachment: Attachment): Promise<Buffer> {
  const data = attachment.data ?? (await attachment.fetchData?.());
  if (data === undefined) throw new Error("attachment has no data");
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data instanceof Blob ? await data.arrayBuffer() : data);
}

export function createAttachmentStore(objects: ObjectStore): AttachmentStore {
  return {
    async save(bot, message) {
      const candidates = message.attachments.flatMap((attachment) => {
        const mimeType = storedMimeType(attachment);
        const type = mimeType ? STORED_TYPES[mimeType] : undefined;
        const nameFits = !type?.hasValidContent || nameHasExtension(attachment, type.extension);
        return mimeType && type && nameFits ? [{ attachment, mimeType, type }] : [];
      });
      const prefix = attachmentPrefix(bot, message.threadId);
      const keys = await Promise.all(
        candidates.map(async ({ attachment, mimeType, type }, index) => {
          assertWithinLimit(attachment.size ?? 0);
          const body = await readBytes(attachment);
          assertWithinLimit(body.length);
          if (type.hasValidContent?.(body) === false) return undefined;
          const key = `${prefix}${messageStem(message.id)}${index}.${type.extension}`;
          await objects.put(key, body, mimeType);
          return key;
        }),
      );
      return keys.filter((key) => key !== undefined);
    },
    async forThread(bot, threadId) {
      const prefix = attachmentPrefix(bot, threadId);
      const keys = (await objects.list(prefix)).sort();
      return (messageId) =>
        keys.filter((key) => key.slice(prefix.length).startsWith(messageStem(messageId)));
    },
  };
}
