import { createMemoryState } from "@chat-adapter/state-memory";
import { vi } from "vitest";
import { createAccessDecisions } from "../../src/lambda/access-decisions.js";
import { createAccessRequestStore } from "../../src/lambda/access-request-store.js";
import { telegramAdminChannel } from "../../src/lambda/admin-channel.js";
import {
  ADMIN_ID,
  ADMIN_PARAMETER,
  MCP_APPROVAL_PARAMETER,
  MCP_FINGERPRINT,
  MCP_MESSAGE_ID,
  MCP_SUBJECT,
  MCP_THREAD_ID,
} from "./access-fixtures.js";
import { GARDEN_REPOSITORY, posterSetup } from "./poster-fixtures.js";
import { GARDEN_BOT, GARDEN_SLACK_PARAMETERS } from "./receiver-fixtures.js";

export const LINEAR = {
  name: "linear",
  fingerprint: MCP_FINGERPRINT,
  summary: "http https://mcp.example.com/mcp, secrets LINEAR_TOKEN",
};

export const mcpApprovalsRequest = (overrides: Record<string, unknown> = {}) => ({
  operation: "mcp-approvals",
  token: "jwt",
  bot: "garden",
  threadId: MCP_THREAD_ID,
  messageId: MCP_MESSAGE_ID,
  servers: [LINEAR],
  ...overrides,
});

/** A poster whose bot-prefixed state is shared with `store`, as the real poster's per-bot state is. */
export async function mcpApprovalsPoster(
  options: {
    admin?: boolean;
    repository?: string;
    approved?: boolean;
    twoConnections?: boolean;
    /** Applies this decision once, after the pending request is read and before it is marked suspended. */
    decideWhileMarking?: "/approve" | "/deny";
  } = {},
) {
  const {
    admin = true,
    repository = GARDEN_REPOSITORY,
    approved = false,
    twoConnections = false,
    decideWhileMarking,
  } = options;
  const botState = createMemoryState();
  await botState.connect();
  const h = await posterSetup({
    repository,
    parameters: {
      ...(twoConnections ? GARDEN_SLACK_PARAMETERS : {}),
      ...(admin ? { [ADMIN_PARAMETER]: ADMIN_ID } : {}),
      ...(approved ? { [MCP_APPROVAL_PARAMETER]: "{}" } : {}),
    },
    createState: (prefix) => (prefix === "bot:garden:" ? botState : createMemoryState()),
  });
  const store = createAccessRequestStore(botState);
  const pendingRequest = async () => {
    const id = await botState.get<string>(`access-subject:mcp:${MCP_SUBJECT}`);
    return typeof id === "string" ? store.read(id) : null;
  };
  const decisions = createAccessDecisions({
    bot: GARDEN_BOT,
    params: h.params,
    store,
    channel: telegramAdminChannel,
    invalidateAccess: vi.fn(),
    postToThread: vi.fn(async () => ({})),
    dispatcher: h.dispatcher,
    logger: h.logger,
  });
  const decide = async (command: "/approve" | "/deny") =>
    decisions.fromCommand({
      command,
      text: (await pendingRequest())?.id ?? "",
      user: { userId: ADMIN_ID },
      isDM: true,
    });
  if (decideWhileMarking) {
    const set = botState.set.bind(botState);
    let pending = true;
    vi.spyOn(botState, "set").mockImplementation(async (key, value, ttl) => {
      if (pending && key.startsWith("access-request:")) {
        pending = false;
        await decide(decideWhileMarking);
      }
      return set(key, value, ttl);
    });
  }
  return {
    ...h,
    decide,
    botState,
    store,
    pendingRequest,
    statuses: async (overrides: Record<string, unknown> = {}) =>
      (await h.poster(mcpApprovalsRequest(overrides))) as { servers: Record<string, string> },
  };
}
