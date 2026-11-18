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
];
