import { createMemoryState } from "@chat-adapter/state-memory";
import { createAccessRequestStore } from "../../src/lambda/access-request-store.js";
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
import { GARDEN_SLACK_PARAMETERS } from "./receiver-fixtures.js";

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
  } = {},
) {
  const {
    admin = true,
    repository = GARDEN_REPOSITORY,
    approved = false,
    twoConnections = false,
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
  return {
    ...h,
    botState,
    store,
    pendingRequest,
    statuses: async (overrides: Record<string, unknown> = {}) =>
      (await h.poster(mcpApprovalsRequest(overrides))) as { servers: Record<string, string> },
  };
}
