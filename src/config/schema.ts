import { z } from "zod";
import { PROVIDERS } from "./providers.js";

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
  destination: alias.optional(),
});

const chatList = z
  .array(alias)
  .min(1, "must list at least one chat")
  .refine((chats) => new Set(chats).size === chats.length, "must not list a chat twice");

export const centaurConfigSchema = z
  .strictObject({
    bot: alias,
    platform: z.enum(PLATFORMS),
    chats: chatList.optional(),
    destination: z
      .never({
        error:
          "is no longer a top-level key; list the chats the bot listens in under `chats` and name a prompt's chat under `prompts.<name>.destination`",
      })
      .optional(),
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
    provider: z.enum(PROVIDERS),
    model: z.string().min(1),
    effort: z.enum(EFFORT_LEVELS).optional(),
    max_turns: z.number().int().min(1).max(200).default(30),
    max_budget_usd: z.number().positive().max(1000).optional(),
    allowed_tools: toolList,
    persona: repoPath.default(".centaur/persona.md"),
    prompts: z.record(alias, promptSchema).default({}),
  })
  .transform((config, ctx) => {
    const chats = config.chats ?? [];
    const reject = (path: string[], message: string) =>
      ctx.issues.push({ code: "custom", input: config, path, message });
    if (chats.length === 0 && Object.keys(config.prompts).length > 0) {
      reject(["chats"], "is required when prompts are defined, because they post to a chat");
    }
    if (chats.length === 0 && config.respond_to === "all") {
      reject(["chats"], "is required when respond_to is all, because it names the chats it hears");
    }
    const prompts = Object.entries(config.prompts).map(([name, prompt]) => {
      const destination = prompt.destination ?? (chats.length === 1 ? chats[0] : undefined);
      const path = ["prompts", name, "destination"];
      if (chats.length > 1 && destination === undefined) {
        reject(path, "is required when the bot lists several chats");
      } else if (destination !== undefined && !chats.includes(destination)) {
        reject(path, `"${destination}" must be one of the chats listed under chats`);
      }
      return [
        name,
        {
          file: prompt.file ?? `.centaur/prompts/${name}.md`,
          context: prompt.context ?? config.context.scheduled,
          destination: destination ?? "",
        },
      ] as const;
    });
    return { ...config, prompts: Object.fromEntries(prompts) };
  });

export type CentaurConfig = z.output<typeof centaurConfigSchema>;
export type Platform = (typeof PLATFORMS)[number];
export type RespondTo = (typeof RESPOND_TO)[number];
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];
