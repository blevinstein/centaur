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
});
