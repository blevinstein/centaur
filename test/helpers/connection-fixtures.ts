import { vi } from "vitest";
import type { Platform, PlatformSettings } from "../../src/config/index.js";
import { approvedParameter } from "../../src/lambda/connection-paths.js";
import { createReceiver } from "../../src/lambda/receiver.js";
import { botStatePrefix, registryKey } from "../../src/lambda/registry.js";
import {
  connectionParameters,
  fakeAttachments,
  fakeDispatcher,
  fakeLogger,
  fakeParameterStore,
  GARDEN_BOT,
  GARDEN_SLACK_BOT,
  GARDEN_SLACK_PARAMETERS,
  GROUP_CHAT_ID,
} from "./receiver-fixtures.js";
import {
  channelMention,
  channelMessage,
  SLACK_CHANNEL_ID,
  SLACK_REQUESTER_ID,
  signedSlackRequest,
  startFakeSlackApi,
} from "./slack-fixtures.js";
import { strictStates } from "./strict-state.js";
import { stubTelegram, telegramUpdate } from "./telegram-fixtures.js";

export const TELEGRAM_USER_ID = "1001";
export const SLACK_TS = "1699999999.000100";

export const gardenParameters = () => ({
  ...connectionParameters(GARDEN_BOT, GARDEN_BOT.repo),
  ...GARDEN_SLACK_PARAMETERS,
  [approvedParameter("garden", "telegram", "chat", GROUP_CHAT_ID)]: "{}",
  [approvedParameter("garden", "telegram", "user", TELEGRAM_USER_ID)]: "{}",
  [approvedParameter("garden", "slack", "chat", SLACK_CHANNEL_ID)]: "{}",
  [approvedParameter("garden", "slack", "user", SLACK_REQUESTER_ID)]: "{}",
});

export const groupMessage = (text = "the tomatoes have yellow leaves") =>
  telegramUpdate({
    chatId: Number(GROUP_CHAT_ID),
    chatType: "supergroup",
    userId: Number(TELEGRAM_USER_ID),
    text,
  });

export const slackMention = (delivery?: Parameters<typeof signedSlackRequest>[2]) =>
  signedSlackRequest(channelMention(SLACK_TS), GARDEN_SLACK_BOT, delivery);

export const slackChannelChat = () =>
  signedSlackRequest(channelMessage("1700000002.000100"), GARDEN_SLACK_BOT);

export type ConnectionSettings = Partial<Record<Platform, PlatformSettings>>;

/** One bot `garden` with a Telegram and a Slack connection, on a strict shared-prefix state. */
export async function twoConnectionHarness({
  registered = {
    telegram: { respond_to: "all", bot_messages: "ignore" },
    slack: { respond_to: "mention", bot_messages: "ignore" },
  },
  parameters = gardenParameters(),
  failConnects,
}: {
  registered?: ConnectionSettings;
  parameters?: Record<string, string>;
  failConnects?: Record<string, number>;
} = {}) {
  const api = await startFakeSlackApi();
  vi.stubEnv("SLACK_API_URL", api.url);
  const sent = stubTelegram();
  const strict = strictStates(failConnects ? { failConnects } : {});
  const registryState = strict.inner("");
  await registryState.connect();
  await registryState.set(registryKey(GARDEN_BOT.name), { platforms: registered });
  const dispatcher = fakeDispatcher();
  const logger = fakeLogger();
  const close = async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await api.close();
  };
  const receive = await createReceiver({
    params: fakeParameterStore({ ...parameters }),
    createState: strict.createState,
    attachments: fakeAttachments(),
    dispatcher,
    logger,
  }).catch(async (error) => {
    await close();
    throw error;
  });
  const dispatched = () => dispatcher.dispatch.mock.calls.map(([, , payload]) => payload);
  return {
    receive,
    dispatcher,
    dispatched,
    sent,
    logger,
    strict,
    botState: strict.inner(botStatePrefix(GARDEN_BOT.name)),
    close,
  };
}
