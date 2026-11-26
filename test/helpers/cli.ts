import type { CliContext } from "../../src/cli/context.js";
import { buildProgram } from "../../src/cli/program.js";
import type { SecretReader } from "../../src/cli/secret-input.js";
import type { Platform } from "../../src/config/index.js";
import {
  approvedParameter,
  approverParameter,
  connectionParameter,
  mcpApprovalParameter,
  repoParameter,
  scopedChatParameter,
} from "../../src/lambda/connection-paths.js";
import { parseDestination } from "../../src/lambda/destinations.js";
import { STATE_TABLE_PARAMETER } from "../../src/lambda/parameters.js";
import {
  fakeChatAccess,
  seedTailBot,
  TAIL_TABLE,
  type TailAccessOptions,
} from "./chat-tail-fixtures.js";
import { FakeParameterStore } from "./fake-parameter-store.js";

export function createCliHarness(
  secrets: Record<string, string> = {},
  telegram: CliContext["telegram"] = { getMe: async () => ({ username: "garden_bot" }) },
  store = new FakeParameterStore(),
  chatAccess: CliContext["chatAccess"] = fakeChatAccess().access,
  exec: CliContext["exec"] = async () => "",
  github: CliContext["github"] = async () => {
    throw new Error("unexpected GitHub call");
  },
) {
  const output: string[] = [];
  const readSecrets: SecretReader = async (names) =>
    Object.fromEntries(names.map((name) => [name, secrets[name] ?? ""]));
  const program = buildProgram({
    store,
    telegram,
    chatAccess,
    readSecrets,
    exec,
    github,
    log: (message) => output.push(message),
  });
  return {
    store,
    output,
    run: (...args: string[]) => program.parseAsync(args, { from: "user" }),
    /** Writes a connection's token directly, as `bot add` would. */
    connect: (bot: string, platform: Platform, token = "t") =>
      store.put(connectionParameter(bot, platform, "token"), token, { secure: true }),
    bind: (bot: string, repo: string) => store.put(repoParameter(bot), repo, { secure: false }),
    /** Approves a chat directly, as `access approve` would. */
    approveChat: (bot: string, platform: Platform, chatId: string) =>
      store.put(approvedParameter(bot, platform, "chat", chatId), "{}", { secure: false }),
    /** Writes an approver entry directly, as an approved chat request would. */
    addApprover: (bot: string, platform: Platform, userId: string, approver?: string) =>
      store.put(
        approverParameter(bot, platform, userId),
        approver ? JSON.stringify({ approver, at: "2026-01-02T03:04:05.000Z" }) : "{}",
        { secure: false },
      ),
    /** Records an MCP server approval directly, as the poster does on an admin decision. */
    approveMcp: (bot: string, name: string, fingerprint: string, at = "2026-01-02T03:04:05.000Z") =>
      store.put(
        mcpApprovalParameter(bot, name, fingerprint),
        JSON.stringify({ at, approver: "U1" }),
        { secure: false },
      ),
    /** The parsed destination record stored under a name, if any. */
    destinationNamed: async (platform: Platform, name: string) => {
      const value = await store.get(scopedChatParameter(platform, name));
      return value === undefined ? undefined : parseDestination(value);
    },
  };
}

export type CliHarness = ReturnType<typeof createCliHarness>;

/** A harness with the bot `garden` connected on each platform and a scripted chat for `chat tail`. */
export async function createTailHarness(
  platforms: Platform[],
  {
    parameterTable = TAIL_TABLE,
    chatAccess,
    ...options
  }: TailAccessOptions & { chatAccess?: CliContext["chatAccess"] } = {},
) {
  const fake = fakeChatAccess(options);
  const cli = createCliHarness({}, undefined, undefined, chatAccess ?? fake.access);
  if (parameterTable) {
    await cli.store.put(STATE_TABLE_PARAMETER, parameterTable, { secure: false });
  }
  for (const platform of platforms) await seedTailBot(cli.store, platform);
  return { ...cli, fake };
}

export const approverPath = (id: string, platform: Platform = "telegram", bot = "garden") =>
  approverParameter(bot, platform, id);

const ADMIN_IDS: Record<Platform, string> = { telegram: "5001", slack: "U1" };

/** A harness with `garden` connected on each platform and an admin set on each. */
export async function createApproverHarness(platforms: Platform[] = ["telegram"]) {
  const cli = createCliHarness();
  for (const platform of platforms) {
    await cli.connect("garden", platform);
    await cli.run("admin", "set", `--${platform}`, ADMIN_IDS[platform]);
  }
  return cli;
}
