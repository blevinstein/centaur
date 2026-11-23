import { createPosterClient } from "../workflows/aws.js";
import { requireEnv } from "../workflows/env.js";
import { oidcTokenFetcher } from "../workflows/oidc-token.js";
import { readTurnState } from "../workflows/turn-state.js";
import { serveChatServer } from "./chat-server.js";
import { createPosterChatClient } from "./poster-chat-client.js";
import { CHAT_SERVER_ENV } from "./server-config.js";

async function main() {
  const state = await readTurnState(requireEnv(CHAT_SERVER_ENV.stateDir));
  if (!state.threadId) throw new Error("the turn has no dispatched thread");
  await serveChatServer({
    client: createPosterChatClient(
      createPosterClient(requireEnv("CENTAUR_FUNCTION_NAME")),
      oidcTokenFetcher(process.env, requireEnv("CENTAUR_OIDC_AUDIENCE")),
      { bot: state.bot, threadId: state.threadId },
    ),
    currentThreadId: state.threadId,
    maxThreads: Number(requireEnv(CHAT_SERVER_ENV.maxThreads)),
    maxMessages: Number(requireEnv(CHAT_SERVER_ENV.maxMessages)),
  });
}

main().catch((error) => {
  process.stderr.write(`centaur-chat: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exit(1);
});
