import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { approvedParameter } from "../../src/lambda/connection-paths.js";
import { createReceiver } from "../../src/lambda/receiver.js";
import {
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeParameterStore,
  PARAMETERS,
  SLACK_BOT,
} from "./receiver-fixtures.js";

export const SLACK_ADMIN_ID = "UADMIN";
export const SLACK_REQUESTER_ID = "UREQUESTER";
export const SLACK_BOT_USER_ID = "UBOT";
export const SLACK_CHANNEL_ID = "C0CLNRASDJ4";
export const SLACK_DM_CHANNEL_ID = "DADMIN1";
export const SLACK_CHANNEL_NAME = "centaur-test";

interface SlackCall {
  method: string;
  body: Record<string, string>;
  response: Record<string, string>;
}

const RESPONSES: Record<string, (body: Record<string, string>, seq: number) => object> = {
  "auth.test": () => ({ user_id: SLACK_BOT_USER_ID, bot_id: "B1", user: "centaur-slack" }),
  "conversations.open": () => ({ channel: { id: SLACK_DM_CHANNEL_ID } }),
  "conversations.info": (body) => ({ channel: { id: body.channel, name: SLACK_CHANNEL_NAME } }),
  "conversations.replies": (body) => ({ messages: [{ ts: body.ts }] }),
  "users.info": (body) => ({
    user: { id: body.user, name: body.user?.toLowerCase(), real_name: `Name of ${body.user}` },
  }),
  "chat.postMessage": (body, seq) => ({ channel: body.channel, ts: `1700000000.${seq}` }),
};

export async function startFakeSlackApi() {
  const calls: SlackCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").replace(/^\/api\//, "");
      const raw = Buffer.concat(chunks).toString();
      const body = Object.fromEntries(new URLSearchParams(raw));
      const payload = RESPONSES[method]?.(body, calls.length + 1) ?? {};
      calls.push({ method, body, response: payload as Record<string, string> });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, ...payload }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/`,
    calls,
    posts: () => calls.filter((call) => call.method === "chat.postMessage"),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const signedSlackRequest = (event: object, secret = SLACK_BOT.webhookSecret) => {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request(`https://example.test/slack/${SLACK_BOT.name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
};

export const channelMention = (ts = "1699999999.000100") => ({
  type: "app_mention",
  channel: SLACK_CHANNEL_ID,
  user: SLACK_REQUESTER_ID,
  text: `<@${SLACK_BOT_USER_ID}> hello`,
  ts,
  event_ts: ts,
});

export const channelMessage = (ts: string, threadTs?: string, text = "and another thing") => ({
  type: "message",
  channel: SLACK_CHANNEL_ID,
  channel_type: "channel",
  user: SLACK_REQUESTER_ID,
  text,
  ts,
  event_ts: ts,
  ...(threadTs ? { thread_ts: threadTs } : {}),
});

export const reactionOn = (ts: string, reaction: string, user = SLACK_ADMIN_ID) => ({
  type: "reaction_added",
  user,
  reaction,
  item: { type: "message", channel: SLACK_DM_CHANNEL_ID, ts },
  event_ts: "1700000100.000100",
});

export async function slackApprovalHarness(extraParameters: Record<string, string> = {}) {
  const api = await startFakeSlackApi();
  vi.stubEnv("SLACK_API_URL", api.url);
  const params = fakeParameterStore({
    ...PARAMETERS,
    "/centaur/admin/slack": SLACK_ADMIN_ID,
    ...extraParameters,
  });
  const dispatcher = fakeDispatcher();
  const logger = fakeLogger();
  const receive = await createReceiver({
    params,
    createState: () => createMemoryState(),
    attachments: fakeAttachments(),
    dispatcher,
    logger,
  });
  const adminDmPost = () => api.posts().find((post) => post.body.channel === SLACK_DM_CHANNEL_ID);
  return {
    api,
    dispatcher,
    params,
    logger,
    adminDmPost,
    receive: (event: object) => receive(signedSlackRequest(event)),
    close: async () => {
      vi.unstubAllEnvs();
      await api.close();
    },
  };
}

export const slackEnrolledHarness = () =>
  slackApprovalHarness({
    [approvedParameter(SLACK_BOT.name, "slack", "chat", SLACK_CHANNEL_ID)]: "1",
    [approvedParameter(SLACK_BOT.name, "slack", "user", SLACK_REQUESTER_ID)]: "1",
  });
