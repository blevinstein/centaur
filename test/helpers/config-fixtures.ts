export const minimalConfig = `
bot: garden
platform: telegram
provider: anthropic
model: sonnet
allowed_tools: Read,Edit
`;

export const fullConfig = `
bot: garden
platform: telegram
respond_to: all
context:
  default: resume
  scheduled: fresh
handle: garden_helper_bot
provider: anthropic
model: sonnet
effort: low
max_turns: 12
max_budget_usd: 0.5
allowed_tools: "Read, Edit,Write,Glob,Grep"
persona: .centaur/persona.md
prompts:
  weekly-tasks:
    context: transcript
    destination: household
  seasonal:
    file: .centaur/prompts/season.md
    destination: workshop
`;

const BASE = "bot: a\nplatform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read";

export const withExtra = (line: string) => `${BASE}\n${line}`;

const MCP_BASE = "bot: a\nplatform: slack\nprovider: anthropic\nmodel: sonnet";

export const withMcp = (servers: string, tools: string) =>
  `${MCP_BASE}\nmcp_servers:\n${servers}\nallowed_tools: [${tools}]`;

export const remoteServerYaml = `  linear:
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: { secret: LINEAR_API_KEY, prefix: "Bearer " }
      X-Org: acme
`;

export const localServerYaml = `  docs-search:
    command: npx
    args: ["-y", "@example/docs-mcp@1.4.2"]
    env:
      INDEX_URL: https://docs.example.com/index
      API_KEY: { secret: DOCS_API_KEY }
`;

export const invalidConfigs: [name: string, text: string, path: string, message: RegExp][] = [
  ["unknown effort", withExtra("effort: extreme"), "effort", /./],
  ["zero max_turns", withExtra("max_turns: 0"), "max_turns", /./],
  ["fractional max_turns", withExtra("max_turns: 2.5"), "max_turns", /./],
  ["excessive max_turns", withExtra("max_turns: 500"), "max_turns", /./],
  ["negative max_budget_usd", withExtra("max_budget_usd: -1"), "max_budget_usd", /./],
  ["excessive max_budget_usd", withExtra("max_budget_usd: 5000"), "max_budget_usd", /./],
  ["handle with an @", withExtra('handle: "@garden_bot"'), "handle", /without the @/],
  [
    "unknown respond_to value",
    "bot: a\nplatform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\nrespond_to: some",
    "respond_to",
    /./,
  ],
  ...["allow: [x]", "chats: [h]", "allow: []", "chats: []"].map(
    (line) =>
      [
        `${line.split(":")[0]} (${line})`,
        withExtra(line),
        line.split(":")[0] as string,
        /access is managed by admin approval.*`centaur access`/,
      ] as [string, string, string, RegExp],
  ),
  [
    "a prompt without a destination",
    withExtra("prompts: {weekly: {}}"),
    "prompts.weekly.destination",
    /./,
  ],
  [
    "an invalid prompt destination alias",
    withExtra("prompts: {weekly: {destination: H}}"),
    "prompts.weekly.destination",
    /lowercase alias/,
  ],
  ["empty document", "", "(root)", /expected object/i],
  ["malformed YAML", "bot: [unclosed", "(root)", /invalid YAML/],
  [
    "missing model",
    "bot: a\nplatform: slack\nprovider: anthropic\nallowed_tools: Read",
    "model",
    /./,
  ],
  [
    "missing provider",
    "bot: a\nplatform: slack\nmodel: sonnet\nallowed_tools: Read",
    "provider",
    /./,
  ],
  [
    "unknown provider",
    withExtra("provider: bedrock").replace("provider: anthropic\n", ""),
    "provider",
    /./,
  ],
  [
    "missing bot",
    "platform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "bot",
    /./,
  ],
  [
    "unknown platform",
    "bot: a\nplatform: irc\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "platform",
    /./,
  ],
  [
    "uppercase bot alias",
    "bot: Garden\nplatform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "bot",
    /lowercase alias/,
  ],
  [
    "bad context policy",
    "bot: a\nplatform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\ncontext: {default: sticky}",
    "context.default",
    /./,
  ],
  [
    "unknown key",
    "bot: a\nplatform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\nextra: 1",
    "(root)",
    /unrecognized key/i,
  ],
  ["missing allowed_tools", "bot: a\nplatform: slack", "allowed_tools", /./],
  [
    "empty tool list",
    'bot: a\nplatform: slack\nallowed_tools: " , "',
    "allowed_tools",
    /at least one tool/,
  ],
  [
    "persona escaping the repo",
    "bot: a\nplatform: slack\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\npersona: ../secret.md",
    "persona",
    /relative path inside the repo/,
  ],
  [
    "bad prompt context",
    withExtra("prompts: {weekly: {context: nope, destination: h}}"),
    "prompts.weekly.context",
    /./,
  ],
  ...[
    [
      "a server with both url and command",
      "  s:\n    url: https://x.example/mcp\n    command: npx",
      "mcp_servers.s",
      /./,
    ],
    ["a server with neither url nor command", "  s: {}", "mcp_servers.s", /./],
    ["an http url", "  s: {url: http://x.example/mcp}", "mcp_servers.s.url", /https URL/],
    ["a server with an unknown key", "  s: {command: npx, cwd: /}", "mcp_servers.s", /./],
    [
      "a secret with an invalid name",
      "  s: {command: npx, env: {K: {secret: lower}}}",
      "mcp_servers.s.env.K.secret",
      /environment variable name/,
    ],
    [
      "a secret with an extra key",
      "  s: {command: npx, env: {K: {secret: K, extra: 1}}}",
      "mcp_servers.s.env.K",
      /unrecognized key/i,
    ],
    [
      "a server name with __",
      "  a__b: {command: npx}",
      "mcp_servers.a__b",
      /must not contain '__'/,
    ],
    [
      "a github-prefixed server name",
      "  github-extra: {command: npx}",
      "mcp_servers.github-extra",
      /reserved/,
    ],
    [
      "an uppercase server name",
      "  Linear: {command: npx}",
      "mcp_servers.Linear",
      /lowercase alias/,
    ],
  ].map(
    ([name, servers, path, message]) =>
      [
        name,
        withMcp(servers as string, "Read, mcp__s__*, mcp__a__b__*, mcp__github-extra, mcp__Linear"),
        path,
        message,
      ] as [string, string, string, RegExp],
  ),
  [
    "an allowed MCP tool naming an undefined server",
    withMcp("  s: {command: npx}", "Read, mcp__s__*, mcp__ghost__search"),
    "allowed_tools[2]",
    /not defined in mcp_servers/,
  ],
  [
    "an MCP server without an allowed_tools entry",
    withMcp("  s: {command: npx}", "Read"),
    "mcp_servers.s",
    /no allowed_tools entry/,
  ],
];
