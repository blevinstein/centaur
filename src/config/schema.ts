import { z } from "zod";
import { PROVIDERS } from "./providers.js";

const MODEL_ID = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

export const PLATFORMS = ["telegram", "slack"] as const;
export const CONTEXT_POLICIES = ["fresh", "transcript", "resume"] as const;
export const THREAD_MODES = ["new", "persistent"] as const;
export const PR_EXISTING_SCOPES = ["off", "bot"] as const;
export const EXECUTION_MODES = ["pull_request", "direct"] as const;
export const AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const;
const DEFAULT_COMMENT_AUTHORS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;
export const CHAT_TOOLS_SCOPES = ["thread", "chat"] as const;
export const CHAT_TOOLS_MAX_THREADS = 50;
export const CHAT_TOOLS_MAX_MESSAGES = 200;
const DEFAULT_CHAT_TOOLS = {
  scope: "thread",
  max_threads: 20,
  max_messages: 50,
  slack_search: false,
} as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const RESPOND_TO = ["mention", "all"] as const;
export const BOT_MESSAGES = ["ignore", "mention"] as const;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const slug = z
  .string()
  .regex(SLUG_PATTERN, "must be a lowercase name (letters, digits, '-' or '_')");

export const isRepoRelativePath = (p: string) =>
  p.length > 0 &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !p.split("/").some((s) => s === ".." || s === "");

const repoPath = z.string().refine(isRepoRelativePath, {
  message: "must be a relative path inside the repo",
});

const contextPolicy = z.enum(CONTEXT_POLICIES);

const DEFAULT_TRANSCRIPT_MAX_CHARS = 100_000;

const toolList = z
  .union([z.string(), z.array(z.string().min(1))])
  .transform((tools) =>
    (typeof tools === "string" ? tools.split(",") : tools).map((t) => t.trim()).filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1, "must list at least one tool"));

const GITHUB_RESERVED_PREFIX = "github";

const serverName = slug
  .refine((name) => !name.includes("__"), {
    message: "must not contain '__' (the separator in mcp__<server>__<tool>)",
  })
  .refine((name) => !name.startsWith(GITHUB_RESERVED_PREFIX), {
    message: `must not start with '${GITHUB_RESERVED_PREFIX}' (reserved for the action's built-in servers)`,
  });

const secretRef = z.strictObject({
  secret: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable name"),
  prefix: z.string().optional(),
});

const serverValues = z.record(z.string().min(1), z.union([z.string(), secretRef]));

const remoteServer = z.strictObject({
  url: z.url().refine((url) => URL.canParse(url) && new URL(url).protocol === "https:", {
    message: "must be an https URL",
  }),
  headers: serverValues.optional(),
});

const localServer = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: serverValues.optional(),
});

const MCP_TOOL_PREFIX = "mcp__";

export const mcpToolMatchesServer = (tool: string, server: string) =>
  tool === `${MCP_TOOL_PREFIX}${server}` || tool.startsWith(`${MCP_TOOL_PREFIX}${server}__`);

const platformName = z.enum(PLATFORMS);

const platformSettingsSchema = z.strictObject({
  respond_to: z.enum(RESPOND_TO).default("mention"),
  bot_messages: z.enum(BOT_MESSAGES).default("ignore"),
});

const platformsSchema = z
  .partialRecord(platformName, platformSettingsSchema)
  .refine((platforms) => Object.keys(platforms).length > 0, {
    message: "must declare at least one platform (telegram or slack)",
  });

const removedPromptPlatforms = z
  .never({
    error:
      "is not supported: name the platform in the destination map, e.g. destination: { slack: <name> }",
  })
  .optional();

const promptSchema = z.strictObject({
  file: repoPath.optional(),
  context: contextPolicy.optional(),
  thread: z.enum(THREAD_MODES).default("new"),
  platforms: removedPromptPlatforms,
  destination: z.union([
    slug,
    z.partialRecord(platformName, slug).refine((names) => Object.keys(names).length > 0, {
      message: "must name a destination for at least one platform",
    }),
  ]),
});

export interface PromptTarget {
  platform: Platform;
  destination: string;
}

type PromptInput = z.output<typeof promptSchema>;

/** A string destination targets the only declared platform; a map targets the platforms it names. */
const promptTargets = (prompt: PromptInput, declared: Platform[]): PromptTarget[] => {
  const { destination } = prompt;
  if (typeof destination === "string") {
    return (declared.length === 1 ? declared : []).map((platform) => ({
      platform,
      destination,
    }));
  }
  return (Object.keys(destination) as Platform[]).map((platform) => ({
    platform,
    destination: destination[platform] as string,
  }));
};

const LEGACY_PLATFORM_KEY_ERROR =
  "is not supported: declare it under `platforms: { <platform>: { respond_to } }`";

const removedPlatformKey = z.never({ error: LEGACY_PLATFORM_KEY_ERROR }).optional();

const instructionsSchema = z.strictObject({
  chat: repoPath.optional(),
  chat_tools: repoPath.optional(),
  comment: repoPath.optional(),
  scheduled: repoPath.optional(),
  silence: repoPath.optional(),
});

const removedAccessKey = z
  .never({
    error:
      "is not supported: access is managed by admin approval; see `centaur access` and docs/onboarding.md",
  })
  .optional();

export const centaurConfigSchema = z
  .strictObject({
    bot: slug,
    platforms: platformsSchema,
    platform: removedPlatformKey,
    respond_to: removedPlatformKey,
    allow: removedAccessKey,
    chats: removedAccessKey,
    context: z
      .strictObject({
        default: contextPolicy.default("transcript"),
        scheduled: contextPolicy.default("fresh"),
        transcript_max_chars: z.number().int().positive().default(DEFAULT_TRANSCRIPT_MAX_CHARS),
      })
      .default({
        default: "transcript",
        scheduled: "fresh",
        transcript_max_chars: DEFAULT_TRANSCRIPT_MAX_CHARS,
      }),
    provider: z.enum(PROVIDERS),
    model: z
      .string()
      .regex(MODEL_ID, "model must be a model id or alias such as sonnet or claude-opus-4-1"),
    effort: z.enum(EFFORT_LEVELS).optional(),
    max_turns: z.number().int().min(1).max(200).default(30),
    max_budget_usd: z.number().positive().max(1000).optional(),
    allowed_tools: toolList,
    mcp_servers: z
      .record(z.string(), z.union([remoteServer, localServer]))
      .superRefine((servers, ctx) => {
        for (const name of Object.keys(servers)) {
          for (const issue of serverName.safeParse(name).error?.issues ?? []) {
            ctx.addIssue({ code: "custom", path: [name], message: issue.message });
          }
        }
      })
      .default({}),
    pull_requests: z
      .strictObject({
        comment_new: z.boolean().default(true),
        existing: z.enum(PR_EXISTING_SCOPES).default("bot"),
        comment_authors: z
          .array(z.enum(AUTHOR_ASSOCIATIONS))
          .min(1)
          .default([...DEFAULT_COMMENT_AUTHORS]),
      })
      .default({
        comment_new: true,
        existing: "bot",
        comment_authors: [...DEFAULT_COMMENT_AUTHORS],
      }),
    execution: z
      .strictObject({ mode: z.enum(EXECUTION_MODES).default("pull_request") })
      .default({ mode: "pull_request" }),
    chat_tools: z
      .strictObject({
        scope: z.enum(CHAT_TOOLS_SCOPES).default(DEFAULT_CHAT_TOOLS.scope),
        max_threads: z
          .number()
          .int()
          .min(1)
          .max(CHAT_TOOLS_MAX_THREADS)
          .default(DEFAULT_CHAT_TOOLS.max_threads),
        max_messages: z
          .number()
          .int()
          .min(1)
          .max(CHAT_TOOLS_MAX_MESSAGES)
          .default(DEFAULT_CHAT_TOOLS.max_messages),
        slack_search: z.boolean().default(DEFAULT_CHAT_TOOLS.slack_search),
      })
      .default(DEFAULT_CHAT_TOOLS),
    repository_instructions: z
      .strictObject({
        enabled: z.boolean().default(true),
        max_bytes: z.number().int().min(1).max(262144).default(32768),
        include_repo_root: z.boolean().default(false),
      })
      .default({ enabled: true, max_bytes: 32768, include_repo_root: false }),
    skills: z
      .strictObject({
        builtin: z.boolean().default(true),
        consumer: z.boolean().default(true),
      })
      .default({ builtin: true, consumer: true }),
    persona: repoPath.default(".centaur/persona.md"),
    instructions: instructionsSchema.default({}),
    prompts: z.record(slug, promptSchema).default({}),
  })
  .superRefine((config, ctx) => {
    const declared = declaredPlatforms(config);
    for (const [name, prompt] of Object.entries(config.prompts)) {
      const issue = (key: string, message: string) =>
        ctx.addIssue({ code: "custom", path: ["prompts", name, key], message });
      const targets = promptTargets(prompt, declared);
      if (typeof prompt.destination === "string" && declared.length > 1) {
        issue(
          "destination",
          `is a name, which is ambiguous when the bot declares more than one platform (${declared.join(", ")}); use a per-platform map: destination: { <platform>: <name> }`,
        );
      }
      for (const { platform } of targets) {
        if (!declared.includes(platform)) {
          issue(
            "destination",
            `targets platform "${platform}", which is not declared in platforms`,
          );
        }
      }
      if ((prompt.context ?? config.context.scheduled) === "resume" && targets.length > 1) {
        issue("context", "resume needs one target: a session belongs to one thread");
      }
    }
    if (config.execution.mode === "direct" && config.pull_requests.existing !== "off") {
      ctx.addIssue({
        code: "custom",
        path: ["pull_requests", "existing"],
        message: "must be off with execution.mode: direct",
      });
    }
    if (config.chat_tools.slack_search) {
      const requires = (path: string, ok: boolean, message: string) =>
        ok || ctx.addIssue({ code: "custom", path: ["chat_tools", path], message });
      requires("slack_search", config.chat_tools.scope === "chat", "needs chat_tools.scope: chat");
      requires("slack_search", declared.includes("slack"), "needs the slack platform in platforms");
    }
    const servers = Object.keys(config.mcp_servers);
    config.allowed_tools.forEach((tool, index) => {
      const builtIn = tool.startsWith(`${MCP_TOOL_PREFIX}${GITHUB_RESERVED_PREFIX}`);
      if (
        tool.startsWith(MCP_TOOL_PREFIX) &&
        !builtIn &&
        !servers.some((name) => mcpToolMatchesServer(tool, name))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["allowed_tools", index],
          message: `names an MCP server that is not defined in mcp_servers: ${tool}`,
        });
      }
    });
    for (const name of servers) {
      if (!config.allowed_tools.some((tool) => mcpToolMatchesServer(tool, name))) {
        ctx.addIssue({
          code: "custom",
          path: ["mcp_servers", name],
          message: `has no allowed_tools entry (add mcp__${name}__* or mcp__${name}__<tool>)`,
        });
      }
    }
  })
  .transform((config) => ({
    ...config,
    prompts: Object.fromEntries(
      Object.entries(config.prompts).map(([name, prompt]) => [
        name,
        {
          file: prompt.file ?? `.centaur/prompts/${name}.md`,
          context: prompt.context ?? config.context.scheduled,
          thread: prompt.thread,
          targets: promptTargets(prompt, declaredPlatforms(config)),
        },
      ]),
    ),
  }));

export type CentaurConfig = z.output<typeof centaurConfigSchema>;
export type PlatformSettings = z.output<typeof platformSettingsSchema>;
export type PullRequestsConfig = CentaurConfig["pull_requests"];
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type ChatToolsConfig = CentaurConfig["chat_tools"];
export type ChatToolsScope = (typeof CHAT_TOOLS_SCOPES)[number];
export type Platform = (typeof PLATFORMS)[number];
export type RespondTo = (typeof RESPOND_TO)[number];
export type BotMessages = (typeof BOT_MESSAGES)[number];
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];
export type ThreadMode = (typeof THREAD_MODES)[number];
export const declaredPlatforms = (config: { platforms: Partial<Record<Platform, unknown>> }) =>
  Object.keys(config.platforms) as Platform[];

export function platformSettings(
  config: Pick<CentaurConfig, "platforms">,
  platform: Platform,
): PlatformSettings {
  const settings = config.platforms[platform];
  if (!settings) throw new Error(`the Centaur config does not declare platform "${platform}"`);
  return settings;
}

/** A thread ID in the adapters' format: `telegram:<chat>:<topic>`, `slack:<channel>:<thread ts>`. */
export const buildThreadId = (platform: Platform, chatId: string, topicId: string) =>
  `${platform}:${chatId}:${topicId}`;

/** The platform of a thread ID, which the adapter prefixes (`telegram:<chat>`, `slack:<channel>:<ts>`). */
export function threadPlatform(threadId: string): Platform {
  const prefix = threadId.split(":", 1)[0];
  const platform = PLATFORMS.find((candidate) => candidate === prefix);
  if (!platform) throw new Error("thread ID has no known platform prefix");
  return platform;
}

export type McpServer = CentaurConfig["mcp_servers"][string];
export type SecretRef = z.output<typeof secretRef>;
