export const minimalConfig = `
bot: garden
platform: telegram
allow: [maintainer]
provider: anthropic
model: sonnet
allowed_tools: Read,Edit
`;

export const fullConfig = `
bot: garden
platform: telegram
chats: [household, workshop]
allow: [maintainer, spouse]
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

const BASE =
  "bot: a\nplatform: slack\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read";

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
    "bot: a\nplatform: slack\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\nrespond_to: some",
    "respond_to",
    /./,
  ],
  [
    "respond_to all without chats",
    withExtra("respond_to: all"),
    "chats",
    /required when respond_to is all/,
  ],
  ["an empty chats list", withExtra("chats: []"), "chats", /at least one chat/],
  ["a duplicate chat", withExtra("chats: [h, h]"), "chats", /must not list a chat twice/],
  ["an invalid chat alias", withExtra("chats: [Household]"), "chats[0]", /lowercase alias/],
  [
    "a top-level destination",
    withExtra("destination: h"),
    "destination",
    /no longer a top-level key.*`chats`/,
  ],
  [
    "a prompt destination outside chats",
    withExtra("chats: [h]\nprompts: {weekly: {destination: other}}"),
    "prompts.weekly.destination",
    /"other" must be one of the chats/,
  ],
  [
    "a prompt without destination among several chats",
    withExtra("chats: [h, w]\nprompts: {weekly: {}}"),
    "prompts.weekly.destination",
    /required when the bot lists several chats/,
  ],
  [
    "a prompt destination without chats",
    withExtra("prompts: {weekly: {destination: h}}"),
    "prompts.weekly.destination",
    /must be one of the chats/,
  ],
  [
    "an invalid prompt destination alias",
    withExtra("chats: [h]\nprompts: {weekly: {destination: H}}"),
    "prompts.weekly.destination",
    /lowercase alias/,
  ],
  ["empty document", "", "(root)", /expected object/i],
  ["malformed YAML", "bot: [unclosed", "(root)", /invalid YAML/],
  [
    "missing model",
    "bot: a\nplatform: slack\nallow: [x]\nprovider: anthropic\nallowed_tools: Read",
    "model",
    /./,
  ],
  [
    "missing provider",
    "bot: a\nplatform: slack\nallow: [x]\nmodel: sonnet\nallowed_tools: Read",
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
    "platform: slack\nallow: [a]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "bot",
    /./,
  ],
  [
    "unknown platform",
    "bot: a\nplatform: irc\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "platform",
    /./,
  ],
  [
    "uppercase bot alias",
    "bot: Garden\nplatform: slack\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "bot",
    /lowercase alias/,
  ],
  [
    "empty allow list",
    "bot: a\nplatform: slack\nallow: []\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read",
    "allow",
    /at least one user/,
  ],
  [
    "bad context policy",
    "bot: a\nplatform: slack\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\ncontext: {default: sticky}",
    "context.default",
    /./,
  ],
  [
    "unknown key",
    "bot: a\nplatform: slack\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\nextra: 1",
    "(root)",
    /unrecognized key/i,
  ],
  ["missing allowed_tools", "bot: a\nplatform: slack\nallow: [x]", "allowed_tools", /./],
  [
    "empty tool list",
    'bot: a\nplatform: slack\nallow: [x]\nallowed_tools: " , "',
    "allowed_tools",
    /at least one tool/,
  ],
  [
    "persona escaping the repo",
    "bot: a\nplatform: slack\nallow: [x]\nprovider: anthropic\nmodel: sonnet\nallowed_tools: Read\npersona: ../secret.md",
    "persona",
    /relative path inside the repo/,
  ],
  [
    "prompts without chats",
    withExtra("prompts: {weekly: {}}"),
    "chats",
    /required when prompts are defined/,
  ],
  [
    "bad prompt context",
    withExtra("chats: [h]\nprompts: {weekly: {context: nope}}"),
    "prompts.weekly.context",
    /./,
  ],
];
