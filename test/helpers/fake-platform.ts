import {
  type Adapter,
  Chat,
  type ChatConfig,
  type Logger,
  Message,
  parseMarkdown,
  type StateAdapter,
} from "chat";

export const FAKE_PLATFORM = "fake";
export const FAKE_CHANNEL_ID = `${FAKE_PLATFORM}:room`;
export const FAKE_THREAD_ID = `${FAKE_CHANNEL_ID}:thread`;

export function createFakePlatform(overrides: Partial<Adapter> = {}): Adapter {
  const unused = async () => {
    throw new Error("not used by the fake platform");
  };
  return {
    name: FAKE_PLATFORM,
    userName: "bot",
    persistThreadHistory: true,
    initialize: async () => {},
    channelIdFromThreadId: (threadId) => threadId.split(":").slice(0, 2).join(":"),
    encodeThreadId: ({ channel, thread }: { channel: string; thread: string }) =>
      `${FAKE_PLATFORM}:${channel}:${thread}`,
    decodeThreadId: (threadId) => {
      const [, channel, thread] = threadId.split(":");
      return { channel, thread };
    },
    isDM: () => false,
    parseMessage: unused,
    handleWebhook: unused,
    fetchMessages: unused,
    fetchThread: unused,
    editMessage: unused,
    deleteMessage: unused,
    addReaction: unused,
    ...overrides,
  } as Adapter;
}

export function fakeIncomingMessage(
  id: string,
  { threadId = FAKE_THREAD_ID, text = `text of ${id}` } = {},
) {
  return new Message({
    id,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw: null,
    isMention: true,
    author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
  });
}

const SILENT_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => SILENT_LOGGER,
};

export function createGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

export async function startFakeChat({
  state,
  ...options
}: { state: StateAdapter } & Pick<ChatConfig, "concurrency" | "history">) {
  const adapter = createFakePlatform();
  const chat = new Chat({
    userName: "bot",
    adapters: { [FAKE_PLATFORM]: adapter },
    state,
    ...options,
    logger: SILENT_LOGGER,
  });
  await chat.initialize();
  const receive = (message: Message) =>
    chat.handleIncomingMessage(adapter, message.threadId, message);
  return { chat, adapter, receive };
}
