import { expect } from "vitest";
import type { Exec } from "../../src/workflows/aws.js";

export const LEAKY_THREAD = "telegram:-1001234567890:42";
export const LEAKY_SLACK_THREAD = "slack:C0123ABCD:1700000000.000100";
export const BUCKET_NAME = "session-bucket";

/** Values that identify a chat, thread or user and must never reach an Actions log. */
const ID_SHAPES = [
  /telegram:/,
  /slack:/,
  /-100\d{6,}/,
  /\b[CUW][A-Z0-9]{8,}\b/,
  /sessions\//,
  new RegExp(BUCKET_NAME),
];

/** An `execFile` failure like the real one: the message and stderr both name the S3 object. */
export const failingS3Exec =
  (key: string): Exec =>
  async (_file, args) => {
    const uri = `s3://${BUCKET_NAME}/${key}`;
    throw Object.assign(
      new Error(`Command failed: aws ${args.join(" ")}\ndownload failed: ${uri}`),
      {
        stderr: `download failed: ${uri} An error occurred (404)`,
      },
    );
  };

export const expectNoIds = (text: string) => {
  for (const shape of ID_SHAPES) expect(text).not.toMatch(shape);
};
