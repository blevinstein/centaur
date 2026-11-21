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
vi.mock("../src/lambda/github.js", () => ({ createGitHubDispatcher: () => ({}) }));
vi.mock("../src/lambda/telegram.js", () => ({ createTelegramApi: () => ({}) }));
vi.mock("../src/lambda/oidc.js", () => ({ createGitHubOidcVerifier: () => ({}) }));
vi.mock("../src/lambda/chat.js", () => ({ createChat: () => ({}) }));
vi.mock("@blevinstein/chat-state-dynamodb", () => ({ createDynamoDBState: () => ({}) }));

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
    mocks.post.mockResolvedValue({ ok: true });
    mocks.createPoster.mockReturnValue(mocks.post);
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
});
