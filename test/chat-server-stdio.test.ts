import { afterEach, describe, expect, it } from "vitest";
import { startChatServerProcess } from "./helpers/chat-server-stdio.js";

const open: { close: () => Promise<void> }[] = [];
afterEach(() => Promise.all(open.splice(0).map((s) => s.close())));

describe("chat server process", () => {
  it("lists its tools and answers a call over stdio through the poster", async () => {
    const server = await startChatServerProcess();
    open.push(server);

    const { tools } = await server.mcp.listTools();
    const result = await server.mcp.callTool({ name: "list_threads", arguments: {} });

    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_threads",
      "read_channel",
      "read_thread",
    ]);
    const [part] = result.content as { text: string }[];
    expect(part?.text).toContain("thread-1:");
    expect(part?.text).toContain("window exhausted: yes");
    expect(part?.text).not.toContain("telegram:");
  }, 30_000);

  it("registers search_chat with CENTAUR_CHAT_SLACK_SEARCH=1 and answers a call over stdio", async () => {
    const server = await startChatServerProcess({ slackSearch: true });
    open.push(server);

    const { tools } = await server.mcp.listTools();
    const result = await server.mcp.callTool({
      name: "search_chat",
      arguments: { query: "blight" },
    });

    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_threads",
      "read_channel",
      "read_thread",
      "search_chat",
    ]);
    const [part] = result.content as { text: string }[];
    expect(result.isError).toBeFalsy();
    expect(part?.text).toContain("blight on the tomatoes");
    expect(part?.text).toContain("https://example.slack.com/archives/C0123/p1700000000000200");
  }, 30_000);
});
