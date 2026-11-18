import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PosterRequest } from "../../src/lambda/poster.js";
import { createPosterClient, createThreadStore, type Exec } from "../../src/workflows/aws.js";
import type { ChatMessage } from "../../src/workflows/transcript.js";

export const BUCKET = "session-bucket";
export const THREAD = "telegram:-100:7";
export const THREAD_PREFIX = `sessions/sprout/${THREAD.replaceAll(":", "_")}/`;

export const message = (id: string, text: string, overrides: Partial<ChatMessage> = {}) => ({
  id,
  userId: "u1",
  userName: "Sam",
  fromBot: false,
  text,
  sentAt: `2026-11-17T10:00:0${id}.000Z`,
  ...overrides,
});

export const botMessage = (id: string, text: string) =>
  message(id, text, { fromBot: true, userName: "sprout" });

export const configText = (extra = "", chats = "[household]") => `
bot: sprout
platform: telegram
chats: ${chats}
allow: [maintainer]
provider: anthropic
model: sonnet
allowed_tools: Read,Edit
${extra}`;

type PosterHandler = (request: PosterRequest) => unknown;

export function createFakeAws(handler: PosterHandler = () => ({})) {
  const objects = new Map<string, string>();
  const requests: PosterRequest[] = [];

  const exec: Exec = async (file, args) => {
    if (file !== "aws") throw new Error(`unexpected command ${file}`);
    const [service, action] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1] as string;
    if (service === "lambda") {
      const request = JSON.parse(
        await readFile(flag("--payload").replace("file://", ""), "utf8"),
      ) as PosterRequest;
      requests.push(request);
      const outFile = args.at(-1) as string;
      try {
        await writeFile(outFile, JSON.stringify(handler(request)));
        return JSON.stringify({ StatusCode: 200 });
      } catch (error) {
        await writeFile(
          outFile,
          JSON.stringify({ errorType: "Error", errorMessage: (error as Error).message }),
        );
        return JSON.stringify({ StatusCode: 200, FunctionError: "Unhandled" });
      }
    }
    if (action === "list-objects-v2") {
      const keys = [...objects.keys()].filter((key) => key.startsWith(flag("--prefix")));
      return JSON.stringify(keys.length > 0 ? keys : null);
    }
    const [, , source, target] = args as [string, string, string, string];
    if (source.startsWith("s3://")) {
      const content = objects.get(source.replace(`s3://${BUCKET}/`, "")) ?? "";
      if (target === "-") return content;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    } else {
      objects.set(target.replace(`s3://${BUCKET}/`, ""), await readFile(source, "utf8"));
    }
    return "";
  };

  return {
    objects,
    requests,
    poster: createPosterClient("poster-fn", exec),
    storeFor: (bot: string, threadId: string) => createThreadStore(BUCKET, bot, threadId, exec),
  };
}

export async function createWorkspace(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "centaur-workspace-"));
  const home = await mkdtemp(join(tmpdir(), "centaur-home-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, home };
}
