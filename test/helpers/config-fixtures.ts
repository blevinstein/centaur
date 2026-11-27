import { formatIssues, type McpServer, parseCentaurConfig } from "../../src/config/index.js";

export const DEFAULT_CHAT_TOOLS = {
  scope: "thread",
  max_threads: 20,
  max_messages: 50,
  slack_search: false,
};

const BASE_FIELDS: Record<string, string | undefined> = {
  bot: "a",
  platforms: "{slack: {}}",
  provider: "anthropic",
  model: "sonnet",
  allowed_tools: "Read",
};

export const yamlOf = (overrides: Record<string, string | undefined> = {}) =>
  Object.entries({ ...BASE_FIELDS, ...overrides })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

export const registerConfigText = (overrides: Record<string, string | undefined> = {}) =>
  yamlOf({ bot: "sprout", platforms: "{telegram: {}}", allowed_tools: "Read", ...overrides });

export const minimalConfig = `
bot: garden
platforms:
  telegram: {}
provider: anthropic
model: sonnet
allowed_tools: Read,Edit
`;

export const fullConfig = `
bot: garden
platforms:
  telegram:
    respond_to: all
    bot_messages: mention
  slack: {}
context:
  default: resume
  scheduled: fresh
provider: anthropic
model: sonnet
effort: low
max_turns: 12
max_budget_usd: 0.5
allowed_tools: "Read, Edit,Write,Glob,Grep"
persona: .centaur/persona.md
instructions:
  chat: .centaur/chat.md
  chat_tools: .centaur/chat-tools.md
  comment: .centaur/comment.md
  scheduled: .centaur/scheduled.md
  silence: .centaur/silence.md
prompts:
  weekly-tasks:
    context: transcript
    destination:
      telegram: household
      slack: household
  seasonal:
    file: .centaur/prompts/season.md
    destination:
      telegram: workshop
      slack: workshop-alerts
`;

export const withExtra = (line: string) => `${yamlOf()}\n${line}`;

export const DIRECT_EXECUTION = "execution: {mode: direct}\npull_requests: {existing: off}";

export const invalidExecutionExtras = [
  "execution: {mode: direct}",
  "execution: {mode: push}",
  "execution: {mode: direct, branch: main}",
  "execution: {mode: direct, on_failure: fail}\npull_requests: {existing: off}",
  "execution: direct",
];

export const withMcp = (servers: string, tools: string) =>
  `${yamlOf({ allowed_tools: undefined })}\nmcp_servers:\n${servers}\nallowed_tools: [${tools}]`;

export const withPlatforms = (platforms: string, extra = "") =>
  `${yamlOf({ platforms })}\n${extra}`;

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
  ...["--max-turns", "-x", "-@preset/foo", "a b", "#x"].map(
    (model): [string, string, string, RegExp] => [
      `model ` + JSON.stringify(model),
      yamlOf({ model: JSON.stringify(model) }),
      "model",
      /model must be/,
    ],
  ),
  ["unknown effort", withExtra("effort: extreme"), "effort", /./],
  ["zero max_turns", withExtra("max_turns: 0"), "max_turns", /./],
  ["fractional max_turns", withExtra("max_turns: 2.5"), "max_turns", /./],
  ["excessive max_turns", withExtra("max_turns: 500"), "max_turns", /./],
  ["negative max_budget_usd", withExtra("max_budget_usd: -1"), "max_budget_usd", /./],
  ["excessive max_budget_usd", withExtra("max_budget_usd: 5000"), "max_budget_usd", /./],
  [
    "a removed handle key",
    yamlOf({ platforms: "{slack: {handle: garden_bot}}" }),
    "platforms.slack",
    /unrecognized key/i,
  ],
  [
    "unknown respond_to value",
    yamlOf({ platforms: "{slack: {respond_to: some}}" }),
    "platforms.slack.respond_to",
    /./,
  ],
  [
    "unknown bot_messages value",
    yamlOf({ platforms: "{slack: {bot_messages: all}}" }),
    "platforms.slack.bot_messages",
    /./,
  ],
  [
    "an unknown per-platform key",
    yamlOf({ platforms: "{slack: {other: 1}}" }),
    "platforms.slack",
    /unrecognized key/i,
  ],
  ["missing platforms", yamlOf({ platforms: undefined }), "platforms", /./],
  ["empty platforms", yamlOf({ platforms: "{}" }), "platforms", /at least one platform/],
  ...["platform: slack", "respond_to: all"].map(
    (line) =>
      [
        `the legacy top-level ${line.split(":")[0]}`,
        withExtra(line),
        line.split(":")[0] as string,
        /platforms: \{ <platform>: \{ respond_to \} \}/,
      ] as [string, string, string, RegExp],
  ),
  [
    "a string destination on a multi-platform bot",
    withPlatforms("{telegram: {}, slack: {}}", "prompts: {weekly: {destination: household}}"),
    "prompts.weekly.destination",
    /ambiguous when the bot declares more than one platform \(telegram, slack\).*per-platform map/,
  ],
  [
    "a leftover prompt platforms key",
    withExtra("prompts: {weekly: {platforms: [slack], destination: household}}"),
    "prompts.weekly.platforms",
    /name the platform in the destination map, e\.g\. destination: \{ slack: <name> \}/,
  ],
  [
    "a destination map naming an undeclared platform",
    withExtra("prompts: {weekly: {destination: {telegram: household}}}"),
    "prompts.weekly.destination",
    /"telegram", which is not declared/,
  ],
  [
    "an empty destination map",
    withExtra("prompts: {weekly: {destination: {}}}"),
    "prompts.weekly.destination",
    /at least one platform/,
  ],
  [
    "resume with several targets",
    withPlatforms(
      "{telegram: {}, slack: {}}",
      "prompts: {weekly: {context: resume, destination: {telegram: household, slack: household}}}",
    ),
    "prompts.weekly.context",
    /one target/,
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
    "an unknown thread mode",
    withExtra("prompts: {weekly: {destination: household, thread: forever}}"),
    "prompts.weekly.thread",
    /./,
  ],
  [
    "an invalid prompt destination name",
    withExtra("prompts: {weekly: {destination: H}}"),
    "prompts.weekly.destination",
    /lowercase name/,
  ],
  ...[
    ["an unknown scope", "scope: all", "chat_tools.scope"],
    ["zero max_threads", "max_threads: 0", "chat_tools.max_threads"],
    ["excessive max_threads", "max_threads: 51", "chat_tools.max_threads"],
    ["fractional max_threads", "max_threads: 2.5", "chat_tools.max_threads"],
    ["zero max_messages", "max_messages: 0", "chat_tools.max_messages"],
    ["excessive max_messages", "max_messages: 201", "chat_tools.max_messages"],
    [
      "a non-boolean slack_search",
      "scope: chat, slack_search: yes please",
      "chat_tools.slack_search",
    ],
    ["slack_search without chat scope", "slack_search: true", "chat_tools.slack_search"],
    ["an unknown key", "other: 1", "chat_tools"],
  ].map(
    ([name, field, path]) =>
      [`chat_tools with ${name}`, withExtra(`chat_tools: {${field}}`), path, /./] as [
        string,
        string,
        string,
        RegExp,
      ],
  ),
  [
    "slack_search on a bot without slack",
    withPlatforms("{telegram: {}}", "chat_tools: {scope: chat, slack_search: true}"),
    "chat_tools.slack_search",
    /slack platform/,
  ],
  ["skills with an unknown key", withExtra("skills: {other: true}"), "skills", /unrecognized key/i],
  [
    "skills with a non-boolean switch",
    withExtra("skills: {builtin: sometimes}"),
    "skills.builtin",
    /./,
  ],
  [
    "repository_instructions with an unknown key",
    withExtra("repository_instructions: {file: AGENTS.md}"),
    "repository_instructions",
    /unrecognized key/i,
  ],
  [
    "repository_instructions with a zero max_bytes",
    withExtra("repository_instructions: {max_bytes: 0}"),
    "repository_instructions.max_bytes",
    /./,
  ],
  [
    "repository_instructions with a non-boolean include_repo_root",
    withExtra("repository_instructions: {include_repo_root: sometimes}"),
    "repository_instructions.include_repo_root",
    /./,
  ],
  ["empty document", "", "(root)", /expected object/i],
  ["malformed YAML", "bot: [unclosed", "(root)", /invalid YAML/],
  ["missing model", yamlOf({ model: undefined }), "model", /./],
  ["missing provider", yamlOf({ provider: undefined }), "provider", /./],
  ["unknown provider", yamlOf({ provider: "bedrock" }), "provider", /./],
  ["missing bot", yamlOf({ bot: undefined }), "bot", /./],
  ["unknown platform", yamlOf({ platforms: "{irc: {}}" }), "platforms", /./],
  ["uppercase bot alias", yamlOf({ bot: "Garden" }), "bot", /lowercase name/],
  ["bad context policy", withExtra("context: {default: sticky}"), "context.default", /./],
  ...["0", "-5", "1.5", "lots"].map(
    (value) =>
      [
        `transcript_max_chars of ${value}`,
        withExtra(`context: {transcript_max_chars: ${value}}`),
        "context.transcript_max_chars",
        /./,
      ] as [string, string, string, RegExp],
  ),
  ["unknown key", withExtra("extra: 1"), "(root)", /unrecognized key/i],
  ["missing allowed_tools", yamlOf({ allowed_tools: undefined }), "allowed_tools", /./],
  ["empty tool list", yamlOf({ allowed_tools: '" , "' }), "allowed_tools", /at least one tool/],
  [
    "persona escaping the repo",
    withExtra("persona: ../secret.md"),
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
      "a server name with a dot, which Claude Code never connects",
      "  probe.srv: {command: npx}",
      "mcp_servers.probe.srv",
      /lowercase name/,
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
      /lowercase name/,
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

export const mcpServersFrom = (servers: string): Record<string, McpServer> => {
  const tools = [...servers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => `mcp__${m[1]}__*`).join(", ");
  const result = parseCentaurConfig(withMcp(servers, tools));
  if (!result.ok) throw new Error(formatIssues(result.issues));
  return result.config.mcp_servers;
};

export const envRef = (name: string, prefix = "") => `${prefix}\${${name}}`;
