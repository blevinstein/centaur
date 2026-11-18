import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PosterRequest } from "../lambda/poster.js";

export type Exec = (file: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export const execCommand: Exec = async (file, args) =>
  (await execFileAsync(file, args, { maxBuffer: MAX_BUFFER })).stdout;

const ERROR_MESSAGE_LIMIT = 300;

export class PosterError extends Error {}

export interface PosterClient {
  call<T = unknown>(request: PosterRequest): Promise<T>;
}

/**
 * Invokes the poster Lambda with the ambient AWS credentials. A FunctionError reports only the
 * error type, because error messages for thread operations could echo chat content; `register`
 * carries config problems the author needs, so its message is included.
 */
export function createPosterClient(functionName: string, exec: Exec = execCommand): PosterClient {
  return {
    async call<T>(request: PosterRequest) {
      const dir = await mkdtemp(join(tmpdir(), "centaur-invoke-"));
      try {
        const payloadFile = join(dir, "payload.json");
        const responseFile = join(dir, "response.json");
        await writeFile(payloadFile, JSON.stringify(request));
        const meta = JSON.parse(
          await exec("aws", [
            "lambda",
            "invoke",
            "--function-name",
            functionName,
            "--cli-binary-format",
            "raw-in-base64-out",
            "--payload",
            `file://${payloadFile}`,
            responseFile,
          ]),
        ) as { FunctionError?: string };
        const response = JSON.parse(await readFile(responseFile, "utf8")) as T & {
          errorType?: string;
          errorMessage?: string;
        };
        if (meta.FunctionError) {
          const detail =
            request.operation === "register"
              ? `: ${String(response.errorMessage).slice(0, ERROR_MESSAGE_LIMIT)}`
              : "";
          throw new PosterError(
            `poster ${request.operation} failed (${response.errorType ?? meta.FunctionError})${detail}`,
          );
        }
        return response;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface AttachmentDownloader {
  download(key: string, destination: string): Promise<void>;
}

export function createAttachmentDownloader(
  bucket: string,
  exec: Exec = execCommand,
): AttachmentDownloader {
  return {
    async download(key, destination) {
      await mkdir(dirname(destination), { recursive: true });
      await exec("aws", ["s3", "cp", `s3://${bucket}/${key}`, destination]);
    },
  };
}

const MARKER_FILE = "last-processed";
const SESSION_SUFFIX = ".jsonl";
const safeSegment = (value: string) => value.replaceAll(/[^A-Za-z0-9._-]/g, "_");

/** Content-free per-thread state in the S3 session bucket: Claude sessions and the marker. */
export interface ThreadStore {
  readMarker(): Promise<string | undefined>;
  writeMarker(messageId: string): Promise<void>;
  restoreSession(directory: string): Promise<string | undefined>;
  saveSession(directory: string, sessionId: string): Promise<void>;
}

export function createThreadStore(
  bucket: string,
  bot: string,
  threadId: string,
  exec: Exec = execCommand,
): ThreadStore {
  const prefix = `sessions/${safeSegment(bot)}/${safeSegment(threadId)}/`;
  const uri = (name: string) => `s3://${bucket}/${prefix}${name}`;
  const listNames = async () => {
    const keys = JSON.parse(
      await exec("aws", [
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--prefix",
        prefix,
        "--query",
        "Contents[].Key",
        "--output",
        "json",
      ]),
    ) as string[] | null;
    return (keys ?? []).map((key) => key.slice(prefix.length));
  };
  return {
    async readMarker() {
      if (!(await listNames()).includes(MARKER_FILE)) return undefined;
      return (await exec("aws", ["s3", "cp", uri(MARKER_FILE), "-"])).trim();
    },
    async writeMarker(messageId) {
      const dir = await mkdtemp(join(tmpdir(), "centaur-marker-"));
      try {
        const file = join(dir, MARKER_FILE);
        await writeFile(file, messageId);
        await exec("aws", ["s3", "cp", file, uri(MARKER_FILE)]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async restoreSession(directory) {
      const name = (await listNames()).find((n) => n.endsWith(SESSION_SUFFIX));
      if (!name) return undefined;
      await exec("aws", ["s3", "cp", uri(name), join(directory, name)]);
      return name.slice(0, -SESSION_SUFFIX.length);
    },
    async saveSession(directory, sessionId) {
      const name = `${sessionId}${SESSION_SUFFIX}`;
      await exec("aws", ["s3", "cp", join(directory, name), uri(name)]);
    },
  };
}
