export const CHAT_SERVER_NAME = "centaur-chat";

/** Environment variables the turn's `mcp.json` passes to the chat server process. */
export const CHAT_SERVER_ENV = {
  stateDir: "CENTAUR_TURN_STATE_DIR",
  maxThreads: "CENTAUR_CHAT_MAX_THREADS",
  maxMessages: "CENTAUR_CHAT_MAX_MESSAGES",
} as const;
