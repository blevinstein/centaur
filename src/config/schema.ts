import { z } from "zod";
import { PROVIDERS } from "./providers.js";

export const PLATFORMS = ["telegram", "slack"] as const;
export const CONTEXT_POLICIES = ["fresh", "transcript", "resume"] as const;
export const PR_EXISTING_SCOPES = ["off", "bot"] as const;
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
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const RESPOND_TO = ["mention", "all"] as const;

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const alias = z
  .string()
  .regex(ALIAS_PATTERN, "must be a lowercase alias (letters, digits, '-' or '_')");

const repoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "must be a relative path inside the repo",
  });

const contextPolicy = z.enum(CONTEXT_POLICIES);

const toolList = z
  .union([z.string(), z.array(z.string().min(1))])
  .transform((tools) =>
    (typeof tools === "string" ? tools.split(",") : tools).map((t) => t.trim()).filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1, "must list at least one tool"));

const GITHUB_RESERVED_PREFIX = "github";

const serverName = alias
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

const mcpToolMatchesServer = (tool: string, server: string) =>
  tool === `${MCP_TOOL_PREFIX}${server}` || tool.startsWith(`${MCP_TOOL_PREFIX}${server}__`);

const promptSchema = z.strictObject({
  file: repoPath.optional(),
  context: contextPolicy.optional(),
  destination: alias,
});

const instructionsSchema = z.strictObject({
  chat: repoPath.optional(),
  comment: repoPath.optional(),
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
    bot: alias,
    platform: z.enum(PLATFORMS),
    allow: removedAccessKey,
    chats: removedAccessKey,
    respond_to: z.enum(RESPOND_TO).default("mention"),
    context: z
      .strictObject({
        default: contextPolicy.default("transcript"),
        scheduled: contextPolicy.default("fresh"),
      })
      .default({ default: "transcript", scheduled: "fresh" }),
    handle: z
      .string()
      .regex(/^[A-Za-z0-9_]{3,64}$/, "must be the bot's username without the @")
      .optional(),
    provider: z.enum(PROVIDERS),
    model: z.string().min(1),
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
    persona: repoPath.default(".centaur/persona.md"),
    instructions: instructionsSchema.default({}),
    prompts: z.record(alias, promptSchema).default({}),
  })
  .superRefine((config, ctx) => {
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
          destination: prompt.destination,
        },
      ]),
    ),
  }));

export type CentaurConfig = z.output<typeof centaurConfigSchema>;
export type PullRequestsConfig = CentaurConfig["pull_requests"];
export type Platform = (typeof PLATFORMS)[number];
export type RespondTo = (typeof RESPOND_TO)[number];
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];
export type McpServer = CentaurConfig["mcp_servers"][string];
export type SecretRef = z.output<typeof secretRef>;
