import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { CONTEXT_POLICIES } from "../config/index.js";
import { OPTIONAL_TOKEN_OPERATIONS } from "../lambda/caller-check.js";
import {
  type ListThreadsRequest,
  type ListThreadsResult,
  listThreadsResultSchema,
  type ReadChannelRequest,
  type ReadChannelResult,
  readChannelResultSchema,
} from "../lambda/chat-context.js";
import {
  type McpApprovalsRequest,
  type McpApprovalsResult,
  mcpApprovalsResultSchema,
} from "../lambda/mcp-approvals.js";
import type { PosterRequest } from "../lambda/poster.js";
import { firstLine } from "../lambda/text.js";
import { SafeError } from "./safe-error.js";
import type { ChatMessage } from "./transcript.js";

export type Exec = (file: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export const execCommand: Exec = async (file, args) =>
  (await execFileAsync(file, args, { maxBuffer: MAX_BUFFER })).stdout;

const ERROR_MESSAGE_LIMIT = 300;

export class PosterError extends SafeError {}

/** The aws CLI's first stderr line, or the spawn error code; never the command line, which names the payload file. */
const execFailureDetail = (error: unknown) => {
  const { stderr, code } = error as { stderr?: unknown; code?: unknown };
  const line = typeof stderr === "string" ? firstLine(stderr, ERROR_MESSAGE_LIMIT) : "";
  return line || (typeof code === "string" ? code : "error");
};

export interface PosterClient {
  call<T = unknown>(request: PosterRequest): Promise<T>;
  listThreads(request: Omit<ListThreadsRequest, "operation">): Promise<ListThreadsResult>;
  readChannel(request: Omit<ReadChannelRequest, "operation">): Promise<ReadChannelResult>;
  mcpApprovals(request: Omit<McpApprovalsRequest, "operation">): Promise<McpApprovalsResult>;
}

/** Adds the OIDC token to an operation that takes it optionally; a failed mint sends none, and a poster that requires one rejects the call. */
async function withCallerToken(request: PosterRequest, fetchToken?: () => Promise<string>) {
  if (!fetchToken || !OPTIONAL_TOKEN_OPERATIONS.has(request.operation)) return request;
  if ("token" in request && request.token) return request;
  const token = await fetchToken().catch(() => undefined);
  return token ? ({ ...request, token } as PosterRequest) : request;
}

/**
 * Invokes the poster Lambda with the ambient AWS credentials. With `fetchToken`, the operations
 * that take the OIDC token optionally carry one, so the poster can check the caller's repository. A FunctionError reports only the
 * error type, because error messages for thread operations could echo chat content; `register`
 * carries config problems the author needs, so its message is included.
 */
export function createPosterClient(
  functionName: string,
  exec: Exec = execCommand,
  fetchToken?: () => Promise<string>,
): PosterClient {
  const client: PosterClient = {
    async call<T>(unsigned: PosterRequest) {
      const request = await withCallerToken(unsigned, fetchToken);
      const dir = await mkdtemp(join(tmpdir(), "centaur-invoke-"));
      try {
        const payloadFile = join(dir, "payload.json");
        const responseFile = join(dir, "response.json");
        await writeFile(payloadFile, JSON.stringify(request));
        const invoked = await exec("aws", [
          "lambda",
          "invoke",
          "--function-name",
          functionName,
          "--cli-binary-format",
          "raw-in-base64-out",
          "--payload",
          `file://${payloadFile}`,
          responseFile,
        ]).catch((error: unknown) => {
          throw new PosterError(`aws lambda invoke failed: ${execFailureDetail(error)}`);
        });
        const meta = JSON.parse(invoked) as { FunctionError?: string };
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
    async listThreads(request) {
      return listThreadsResultSchema.parse(
        await client.call({ operation: "list-threads", ...request }),
      );
    },
    async readChannel(request) {
      return readChannelResultSchema.parse(
        await client.call({ operation: "read-channel", ...request }),
      );
    },
    async mcpApprovals(request) {
      return mcpApprovalsResultSchema.parse(
        await client.call({ operation: "mcp-approvals", ...request }),
      );
    },
  };
  return client;
}

/** The poster's `read` result; `policy` is absent for a thread with no stored context policy. */
const readResultSchema = z.object({
  messages: z.custom<ChatMessage[]>(),
  policy: z.enum(CONTEXT_POLICIES).optional(),
});

type ReadRequest = { token: string; bot: string; threadId: string; visibleOnly?: boolean };

/** A thread's stored transcript (oldest first) and its stored context policy, when it has one. */
export async function readThread(poster: Pick<PosterClient, "call">, request: ReadRequest) {
  return readResultSchema.parse(await poster.call({ operation: "read", ...request }));
}

/** The stored transcript of a thread, oldest first. */
export async function readThreadMessages(poster: Pick<PosterClient, "call">, request: ReadRequest) {
  return (await readThread(poster, request)).messages;
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

/** Per-thread state in the S3 session bucket: the Claude session transcript and the marker. */
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
