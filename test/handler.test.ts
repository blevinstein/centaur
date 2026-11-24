import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUNCTION_URL_PARAMETER, GITHUB_TOKEN_PARAMETER } from "../src/lambda/parameters.js";
import { HANDLER_ENV, handlerParams, importFreshHandler } from "./helpers/handler-fixtures.js";
import { functionUrlEvent } from "./helpers/lambda-events.js";

const mocks = vi.hoisted(() => ({
  params: undefined as unknown,
  receive: vi.fn(),
  post: vi.fn(),
  createReceiver: vi.fn(),
  createPoster: vi.fn(),
  createState: vi.fn(),
  createDispatcher: vi.fn(),
}));

vi.mock("../src/lambda/parameters.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lambda/parameters.js")>()),
  createSsmParameterStore: () => mocks.params,
}));
vi.mock("../src/lambda/receiver.js", () => ({ createReceiver: mocks.createReceiver }));
vi.mock("../src/lambda/poster.js", () => ({ createPoster: mocks.createPoster }));
vi.mock("../src/lambda/attachments.js", () => ({
  createS3ObjectStore: () => ({}),
  createAttachmentStore: () => ({}),
}));
vi.mock("../src/lambda/github.js", () => ({
  createGitHubDispatcher: (token: string) => mocks.createDispatcher(token),
}));
vi.mock("../src/lambda/telegram.js", () => ({ createTelegramApi: () => ({}) }));
vi.mock("../src/lambda/oidc.js", () => ({ createGitHubOidcVerifier: () => ({}) }));
vi.mock("../src/lambda/chat.js", () => ({ createChat: () => ({}) }));
vi.mock("@blevinstein/chat-state-dynamodb", () => ({
  createDynamoDBState: (options: unknown) => mocks.createState(options),
}));

describe("lambda handler routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STATE_TABLE_NAME", HANDLER_ENV.STATE_TABLE_NAME);
    vi.stubEnv("SESSION_BUCKET_NAME", HANDLER_ENV.SESSION_BUCKET_NAME);
    vi.stubEnv("GITHUB_OWNER", HANDLER_ENV.GITHUB_OWNER);
    vi.stubEnv("OIDC_AUDIENCE", HANDLER_ENV.OIDC_AUDIENCE);
    mocks.params = handlerParams({
      [GITHUB_TOKEN_PARAMETER]: "token",
      [FUNCTION_URL_PARAMETER]: "https://fn.example",
    });
    mocks.receive.mockImplementation(
      async () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    );
    mocks.createReceiver.mockResolvedValue(mocks.receive);
    mocks.createDispatcher.mockReturnValue({ dispatch: vi.fn(async () => {}) });
    mocks.post.mockResolvedValue({ ok: true });
    mocks.createPoster.mockReturnValue(mocks.post);
    mocks.createState.mockImplementation(() => ({
      connect: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("routes function URL events to the receiver as web requests", async () => {
    const handler = await importFreshHandler();
    const result = await handler(functionUrlEvent({ body: "{}" }));
    expect(result).toMatchObject({ statusCode: 200, body: "ok" });
    const [request] = mocks.receive.mock.calls[0] as [Request];
    expect(request.url).toBe("https://abc123.lambda-url.us-east-1.on.aws/telegram/mybot");
    expect(await request.text()).toBe("{}");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("routes operation events to the poster without touching the receiver", async () => {
    const handler = await importFreshHandler();
    const event = { operation: "post", bot: "mybot" };
    expect(await handler(event)).toEqual({ ok: true });
    expect(mocks.post).toHaveBeenCalledWith(event);
    expect(mocks.createReceiver).not.toHaveBeenCalled();
  });

  it("passes the receiver's non-200 responses through", async () => {
    mocks.receive.mockResolvedValue(new Response("nope", { status: 404 }));
    const handler = await importFreshHandler();
    const result = await handler(functionUrlEvent({ rawPath: "/unknown" }));
    expect(result).toMatchObject({ statusCode: 404, body: "nope" });
  });

  it("builds the receiver and poster once across invocations", async () => {
    const handler = await importFreshHandler();
    await handler(functionUrlEvent());
    await handler(functionUrlEvent());
    await handler({ operation: "post" });
    await handler({ operation: "post" });
    expect(mocks.createReceiver).toHaveBeenCalledTimes(1);
    expect(mocks.createPoster).toHaveBeenCalledTimes(1);
  });

  it("rejects when the GitHub token parameter is missing, then retries the build", async () => {
    mocks.params = handlerParams({});
    const handler = await importFreshHandler();
    await expect(handler(functionUrlEvent())).rejects.toThrow(
      `missing SSM parameter ${GITHUB_TOKEN_PARAMETER}`,
    );
    mocks.params = handlerParams({ [GITHUB_TOKEN_PARAMETER]: "token" });
    expect(await handler(functionUrlEvent())).toMatchObject({ statusCode: 200 });
  });

  describe("the poster's dispatcher", () => {
    type PosterDispatcher = { dispatch: (...args: string[]) => Promise<void> };
    const dispatch = async (handler: Awaited<ReturnType<typeof importFreshHandler>>) => {
      await handler({ operation: "post" });
      const [deps] = mocks.createPoster.mock.calls[0] as [{ dispatcher: PosterDispatcher }];
      await deps.dispatcher.dispatch("octo/garden", "event");
    };

    it("builds and serves operations without reading the token", async () => {
      mocks.params = handlerParams({ [FUNCTION_URL_PARAMETER]: "https://fn.example" });
      const handler = await importFreshHandler();

      expect(await handler({ operation: "post" })).toEqual({ ok: true });
      expect(mocks.createDispatcher).not.toHaveBeenCalled();
    });

    it("builds the dispatcher on the first dispatch and reuses it", async () => {
      const handler = await importFreshHandler();

      await dispatch(handler);
      await dispatch(handler);

      expect(mocks.createDispatcher).toHaveBeenCalledExactlyOnceWith("token");
    });

    it("rejects when the token read fails and retries on the next dispatch", async () => {
      mocks.params = handlerParams({ [FUNCTION_URL_PARAMETER]: "https://fn.example" });
      const handler = await importFreshHandler();

      await expect(dispatch(handler)).rejects.toThrow(
        `missing SSM parameter ${GITHUB_TOKEN_PARAMETER}`,
      );
      (mocks.params as ReturnType<typeof handlerParams>).entries.set(GITHUB_TOKEN_PARAMETER, {
        value: "token",
        secure: false,
      });
      await dispatch(handler);

      expect(mocks.createDispatcher).toHaveBeenCalledExactlyOnceWith("token");
    });
  });

  it("rejects poster operations when the function URL parameter is missing", async () => {
    mocks.params = handlerParams({});
    const handler = await importFreshHandler();
    await expect(handler({ operation: "post" })).rejects.toThrow(
      `missing SSM parameter ${FUNCTION_URL_PARAMETER}`,
    );
  });

  it("rejects when required environment variables are unset", async () => {
    vi.stubEnv("STATE_TABLE_NAME", "");
    const handler = await importFreshHandler();
    await expect(handler(functionUrlEvent())).rejects.toThrow("STATE_TABLE_NAME is not set");
    await expect(handler({ operation: "post" })).rejects.toThrow("STATE_TABLE_NAME is not set");
  });

  it.each([
    ["receiver", () => mocks.createReceiver, functionUrlEvent({ body: "{}" })],
    ["poster", () => mocks.createPoster, { operation: "read" }],
  ])("hands the %s a DynamoDB adapter factory", async (_name, factory, event) => {
    const handler = await importFreshHandler();
    await handler(event as Parameters<typeof handler>[0]);
    const { createState } = (factory().mock.calls as unknown[][]).flat()[0] as {
      createState: (prefix: string) => unknown;
    };

    createState("bot:garden:");

    expect(mocks.createState).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: HANDLER_ENV.STATE_TABLE_NAME,
        keyPrefix: "bot:garden:",
      }),
    );
  });
});
