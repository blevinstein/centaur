import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliHarness } from "./cli.js";
import { FakeParameterStore } from "./fake-parameter-store.js";
import { createWorkspace } from "./workflow-fixtures.js";

export const legacyConfigText = `# Synthetic consumer config.
bot: sample

# Where the bot lives.
platform: telegram
# Reply to everything in approved chats, however long this explanation runs, because the comment sits above the key it describes.
respond_to: all
handle: sample_helper_bot # the bot's username

context:
  default: transcript
  scheduled: fresh
provider: anthropic
model: sonnet
allowed_tools:
  - Read
  - mcp__tracker__*
mcp_servers:
  tracker:
    command: npx
    args: ["-y", "tracker-mcp"]
    env:
      API_KEY: { secret: TRACKER_KEY } # supplied by the workflow
persona: .centaur/persona.md
prompts:
  weekly:
    context: transcript
    destination: household
`;

export const migratedConfigText = `# Synthetic consumer config.
bot: sample

# Where the bot lives.
platforms:
  telegram:
    # Reply to everything in approved chats, however long this explanation runs, because the comment sits above the key it describes.
    respond_to: all
    handle: sample_helper_bot # the bot's username

context:
  default: transcript
  scheduled: fresh
provider: anthropic
model: sonnet
allowed_tools:
  - Read
  - mcp__tracker__*
mcp_servers:
  tracker:
    command: npx
    args: ["-y", "tracker-mcp"]
    env:
      API_KEY: { secret: TRACKER_KEY } # supplied by the workflow
persona: .centaur/persona.md
prompts:
  weekly:
    context: transcript
    destination: household
`;

const REQUIRED_FIELDS = "provider: anthropic\nmodel: sonnet\nallowed_tools: Read,Edit\n";

export const legacyConfigVariants = {
  "a platform with no settings": {
    legacy: `bot: sample\nplatform: slack\n${REQUIRED_FIELDS}`,
    migrated: `bot: sample\nplatforms:\n  slack: {}\n${REQUIRED_FIELDS}`,
  },
  "a comma-separated allowed_tools string and a trailing comment": {
    legacy: `bot: sample\nplatform: telegram # chat app\nrespond_to: mention\n${REQUIRED_FIELDS}`,
    migrated: `bot: sample\nplatforms: # chat app\n  telegram:\n    respond_to: mention\n${REQUIRED_FIELDS}`,
  },
};

export const unmigratableConfigs = {
  "settings without a platform": `bot: sample\nrespond_to: all\n${REQUIRED_FIELDS}`,
  "an unknown platform": `bot: sample\nplatform: irc\n${REQUIRED_FIELDS}`,
  "both forms at once": `bot: sample\nplatform: slack\nplatforms: {slack: {}}\n${REQUIRED_FIELDS}`,
  "no platform at all": `bot: sample\n${REQUIRED_FIELDS}`,
  "malformed YAML": "bot: [unclosed",
};

/** A flat-layout bot as the previous release stored it. */
export function flatBot(
  store: FakeParameterStore,
  bot: string,
  platform: "telegram" | "slack",
  entries: Record<string, string> = {},
) {
  const secrets =
    platform === "telegram"
      ? { token: "tg-token", "webhook-secret": "tg-hook" }
      : { token: "sl-token", "signing-secret": "sl-sign" };
  store.entries.set(`/centaur/bots/${bot}/platform`, { value: platform, secure: false });
  for (const [key, value] of Object.entries(secrets)) {
    store.entries.set(`/centaur/bots/${bot}/${key}`, { value, secure: true });
  }
  for (const [key, value] of Object.entries(entries)) {
    store.entries.set(`/centaur/bots/${bot}/${key}`, { value, secure: false });
  }
}

export const flatAlias = (store: FakeParameterStore, alias: string, chatId: string) =>
  store.entries.set(`/centaur/chats/${alias}`, { value: chatId, secure: false });

/** A store that drops every write to one parameter, so reading it back fails verification. */
export class LossyParameterStore extends FakeParameterStore {
  constructor(private readonly lossy: string) {
    super();
  }

  override async put(name: string, value: string, options: { secure: boolean }) {
    if (name !== this.lossy) await super.put(name, value, options);
  }
}

export const NESTED_TELEGRAM = "/centaur/bots/sample/platforms/telegram";

export const backupPath = async () =>
  join(await mkdtemp(join(tmpdir(), "centaur-backup-")), "backup.json");

export const populated = () => {
  const cli = createCliHarness();
  flatBot(cli.store, "sample", "telegram", {
    "approved-chats/-100": '{"at":"x"}',
    "approved-users/7": '{"at":"x"}',
    "blocked/user/9": '{"at":"x"}',
  });
  flatAlias(cli.store, "household", "-100");
  cli.bind("sample", "owner/repo");
  return cli;
};

export const nestedNames = (cli: ReturnType<typeof populated>) =>
  cli.store
    .names()
    .filter((name) => name.includes("/platforms/") || name.startsWith("/centaur/chats/telegram/"));

export const foldableBots = () => {
  const cli = createCliHarness({ token: "t", "signing-secret": "s" });
  flatBot(cli.store, "folded", "slack", { "approved-chats/C1": '{"at":"x"}' });
  return cli.run("bot", "migrate").then(async () => {
    await cli.run("bot", "add", "main", "--platform", "telegram");
    return cli;
  });
};

export const migrateConfigFile = async (text: string, ...flags: string[]) => {
  const { root } = await createWorkspace({ "config.yml": text });
  const path = join(root, "config.yml");
  const cli = createCliHarness();
  const result = await cli.run("config", "migrate", path, ...flags).then(
    () => undefined,
    (error: Error) => error,
  );
  return { cli, path, result, text: () => readFile(path, "utf8") };
};
