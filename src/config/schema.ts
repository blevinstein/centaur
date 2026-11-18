import { z } from "zod";

export const PLATFORMS = ["telegram", "slack"] as const;
export const CONTEXT_POLICIES = ["fresh", "transcript", "resume"] as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const RESPOND_TO = ["mention", "all"] as const;

export const alias = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a lowercase alias (letters, digits, '-' or '_')");

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

const promptSchema = z.strictObject({
  file: repoPath.optional(),
  context: contextPolicy.optional(),
});

export const centaurConfigSchema = z
  .strictObject({
    bot: alias,
    platform: z.enum(PLATFORMS),
    destination: alias.optional(),
    allow: z.array(alias).min(1, "must list at least one user"),
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
    model: z.string().min(1).optional(),
    fallback_model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
    max_turns: z.number().int().min(1).max(200).default(30),
    max_budget_usd: z.number().positive().max(1000).optional(),
    allowed_tools: toolList,
    persona: repoPath.default(".centaur/persona.md"),
    prompts: z.record(alias, promptSchema).default({}),
  })
  .transform((config) => ({
    ...config,
    prompts: Object.fromEntries(
      Object.entries(config.prompts).map(([name, prompt]) => [
        name,
        {
          file: prompt.file ?? `.centaur/prompts/${name}.md`,
          context: prompt.context ?? config.context.scheduled,
        },
      ]),
    ),
  }))
  .refine(
    (config) => config.destination !== undefined || Object.keys(config.prompts).length === 0,
    {
      path: ["destination"],
      message:
        "is required when prompts are defined, because scheduled runs need a chat to post to",
    },
  )
  .refine((config) => config.destination !== undefined || config.respond_to === "mention", {
    path: ["destination"],
    message: "is required when respond_to is all, because it names the chat the bot listens in",
  });

export type CentaurConfig = z.output<typeof centaurConfigSchema>;
export type Platform = (typeof PLATFORMS)[number];
export type RespondTo = (typeof RESPOND_TO)[number];
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];
