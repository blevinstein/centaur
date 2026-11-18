import { describe, expect, it } from "vitest";
import { buildMcpConfig } from "../src/workflows/mcp-config.js";
import {
  envRef,
  localServerYaml,
  mcpServersFrom,
  remoteServerYaml,
} from "./helpers/config-fixtures.js";

const ENV = { LINEAR_API_KEY: "lin_secret", DOCS_API_KEY: "docs_secret" };

describe("buildMcpConfig", () => {
  it("renders a remote server with a prefixed secret and a plain header", () => {
    const { config, missingSecrets } = buildMcpConfig(mcpServersFrom(remoteServerYaml), ENV);
    expect(config).toEqual({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: envRef("LINEAR_API_KEY", "Bearer "), "X-Org": "acme" },
        },
      },
    });
    expect(missingSecrets).toEqual([]);
  });

  it("renders a local server with args, a plain env value and an unprefixed secret", () => {
    const { config, missingSecrets } = buildMcpConfig(mcpServersFrom(localServerYaml), ENV);
    expect(config).toEqual({
      mcpServers: {
        "docs-search": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@example/docs-mcp@1.4.2"],
          env: { INDEX_URL: "https://docs.example.com/index", API_KEY: envRef("DOCS_API_KEY") },
        },
      },
    });
    expect(missingSecrets).toEqual([]);
  });

  it("omits absent optional fields", () => {
    const servers = mcpServersFrom("  a: {command: npx}\n  b: {url: 'https://x.example/mcp'}");
    expect(buildMcpConfig(servers, {}).config.mcpServers).toEqual({
      a: { type: "stdio", command: "npx" },
      b: { type: "http", url: "https://x.example/mcp" },
    });
  });

  it("produces an empty config for no servers", () => {
    expect(buildMcpConfig({}, ENV)).toEqual({ config: { mcpServers: {} }, missingSecrets: [] });
  });

  it("never writes a secret value into the config", () => {
    const servers = mcpServersFrom(remoteServerYaml + localServerYaml);
    expect(JSON.stringify(buildMcpConfig(servers, ENV).config)).not.toMatch(/_secret/);
  });

  it("reports unset and empty secrets once each", () => {
    const servers = mcpServersFrom(
      `${remoteServerYaml}${localServerYaml}  other:
    url: https://other.example/mcp
    headers:
      X-Key: { secret: LINEAR_API_KEY }
`,
    );
    expect(buildMcpConfig(servers, { DOCS_API_KEY: "" }).missingSecrets).toEqual([
      "LINEAR_API_KEY",
      "DOCS_API_KEY",
    ]);
  });
});
