import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PosterClient, ThreadStore } from "./aws.js";
import { STATE_FILE, type TurnState } from "./prepare.js";
import { clearReactions } from "./reactions.js";

const resultMessage = z.object({
  type: z.literal("result"),
  session_id: z.string().optional(),
  structured_output: z
    .object({
      reply: z.string().min(1).optional(),
      ignore: z.boolean().optional(),
      new_thread_title: z.string().min(1).optional(),
    })
    .refine((output) => (output.reply !== undefined) !== (output.ignore === true)),
});

export function extractResult(executionFileText: string) {
  const entries = JSON.parse(executionFileText) as { type?: string }[];
  const last = entries.findLast((entry) => entry.type === "result");
  const parsed = resultMessage.safeParse(last);
  if (!parsed.success) throw new Error("the agent produced no structured reply");
  return {
    reply: parsed.data.structured_output.reply,
    title: parsed.data.structured_output.new_thread_title,
    sessionId: parsed.data.session_id,
  };
}

export interface FinishDeps {
  workspace: string;
  executionFile: string;
  pullRequestUrl?: string | undefined;
  poster: PosterClient;
  storeFor: (bot: string, threadId: string) => ThreadStore;
}

const readState = async (workspace: string) =>
  JSON.parse(await readFile(join(workspace, STATE_FILE), "utf8")) as TurnState;

async function deliver(
  poster: PosterClient,
  state: TurnState,
  text: string,
  title: string | undefined,
) {
  if (state.mode === "reply" && state.threadId) {
    await poster.call({ operation: "post", bot: state.bot, threadId: state.threadId, text });
    return state.threadId;
  }
  const started = await poster.call<{ threadId: string }>({
    operation: "start-thread",
    bot: state.bot,
    text,
    ...(title ? { title } : {}),
  });
  return started.threadId;
}

async function deliverReply(
  deps: FinishDeps,
  state: TurnState,
  result: ReturnType<typeof extractResult>,
) {
  const text = [result.reply, deps.pullRequestUrl && `Pull request: ${deps.pullRequestUrl}`]
    .filter(Boolean)
    .join("\n\n");
  if (text) return deliver(deps.poster, state, text, result.title);
  if (!state.threadId) throw new Error("the agent can only stay silent in an existing thread");
  return state.threadId;
}

export async function finish(deps: FinishDeps) {
  const state = await readState(deps.workspace);
  const result = extractResult(await readFile(deps.executionFile, "utf8"));
  const threadId = await deliverReply(deps, state, result);

  const store = deps.storeFor(state.bot, threadId);
  if (state.marker) await store.writeMarker(state.marker);
  if (state.policy === "resume" && result.sessionId) {
    await store.saveSession(state.sessionDirectory, result.sessionId);
  }
  await clearReactions(deps.poster, state.source);
}

export async function notifyFailure(
  deps: Pick<FinishDeps, "workspace" | "poster"> & { runUrl: string },
) {
  const state = await readState(deps.workspace);
  try {
    if (state.mode === "reply" && state.threadId) {
      await deps.poster.call({
        operation: "post",
        bot: state.bot,
        threadId: state.threadId,
        text: `That turn failed. Details are in the workflow run: ${deps.runUrl}`,
      });
    }
  } finally {
    await clearReactions(deps.poster, state.source);
  }
}
