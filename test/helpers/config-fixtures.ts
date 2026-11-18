export const minimalConfig = `
bot: garden
platform: telegram
allow: [maintainer]
allowed_tools: Read,Edit
`;

export const fullConfig = `
bot: garden
platform: telegram
destination: household
allow: [maintainer, spouse]
context:
  default: resume
  scheduled: fresh
model: sonnet
allowed_tools: "Read, Edit,Write,Glob,Grep"
persona: .centaur/persona.md
prompts:
  weekly-tasks:
    context: transcript
  seasonal:
    file: .centaur/prompts/season.md
`;

export const invalidConfigs: [name: string, text: string, path: string, message: RegExp][] = [
  ["empty document", "", "(root)", /expected object/i],
  ["malformed YAML", "bot: [unclosed", "(root)", /invalid YAML/],
  ["missing bot", "platform: slack\nallow: [a]\nallowed_tools: Read", "bot", /./],
  ["unknown platform", "bot: a\nplatform: irc\nallow: [x]\nallowed_tools: Read", "platform", /./],
  [
    "uppercase bot alias",
    "bot: Garden\nplatform: slack\nallow: [x]\nallowed_tools: Read",
    "bot",
    /lowercase alias/,
  ],
  [
    "empty allow list",
    "bot: a\nplatform: slack\nallow: []\nallowed_tools: Read",
    "allow",
    /at least one user/,
  ],
  [
    "bad context policy",
    "bot: a\nplatform: slack\nallow: [x]\nallowed_tools: Read\ncontext: {default: sticky}",
    "context.default",
    /./,
  ],
  [
    "unknown key",
    "bot: a\nplatform: slack\nallow: [x]\nallowed_tools: Read\nextra: 1",
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
    "bot: a\nplatform: slack\nallow: [x]\nallowed_tools: Read\npersona: ../secret.md",
    "persona",
    /relative path inside the repo/,
  ],
  [
    "prompts without destination",
    "bot: a\nplatform: slack\nallow: [x]\nallowed_tools: Read\nprompts: {weekly: {}}",
    "destination",
    /required when prompts are defined/,
  ],
  [
    "bad prompt context",
    "bot: a\nplatform: slack\ndestination: h\nallow: [x]\nallowed_tools: Read\nprompts: {weekly: {context: nope}}",
    "prompts.weekly.context",
    /./,
  ],
];
