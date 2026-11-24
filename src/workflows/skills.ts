import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/** The longest `description` Claude Code keeps in its skill listing. */
export const SKILL_DESCRIPTION_MAX = 1536;

const BUILT_IN_PREFIX = "centaur-";
export const CONSUMER_SKILL_PREFIX = `${BUILT_IN_PREFIX}consumer-`;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const TOOL_ENTRY = /[^\s(]+(?:\([^)]*\))?/g;

export interface SkillInstall {
  home: string;
  /** The repository's `skills/` folder; undefined when the built-in skills are off. */
  sourceDir: string | undefined;
  /** The trusted checkout's `.claude/skills`; undefined when consumer skills are off. */
  consumerDir?: string | undefined;
  /** The config's `allowed_tools`: the most a consumer skill's `allowed-tools` may name. */
  allowedTools?: string[];
}

export interface InstalledSkills {
  builtin: string[];
  consumer: string[];
}

export function skillFrontmatter(text: string): Record<string, unknown> {
  const match = FRONTMATTER.exec(text);
  const parsed: unknown = match && parse(match[1] ?? "");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("has no YAML frontmatter");
  }
  return parsed as Record<string, unknown>;
}

const directories = async (dir: string) =>
  (
    await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  ).filter((entry) => entry.isDirectory() || entry.isSymbolicLink());

const toolEntries = (value: unknown) =>
  (typeof value === "string" ? (value.match(TOOL_ENTRY) ?? []) : [value].flat()).map(String);

/** Throws the reason `name` may not be installed; a consumer skill never widens the turn's trust. */
async function checkConsumerSkill(dir: string, name: string, allowedTools: string[]) {
  if (name.startsWith(BUILT_IN_PREFIX)) {
    return `uses the reserved "${BUILT_IN_PREFIX}" prefix of the built-in skills`;
  }
  const entries = await readdir(join(dir, name), { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return `contains a symbolic link (${entry.name})`;
    if (entry.name === ".claude-plugin") return "contains a .claude-plugin folder";
  }
  const text = await readFile(join(dir, name, "SKILL.md"), "utf8").catch(() => undefined);
  if (text === undefined) return "has no SKILL.md";
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = skillFrontmatter(text);
  } catch (error) {
    return (error as Error).message;
  }
  if (frontmatter.name !== name) return "must set the frontmatter name to its folder name";
  if ("hooks" in frontmatter) return "sets hooks in its frontmatter";
  const widening = toolEntries(frontmatter["allowed-tools"] ?? "").filter(
    (tool) => !allowedTools.includes(tool),
  );
  return widening.length > 0
    ? `allows tools outside the config's allowed_tools: ${widening.join(", ")}`
    : undefined;
}

/**
 * Replaces the `centaur-*` folders of `$HOME/.claude/skills` with the built-in skills and the
 * trusted checkout's consumer skills (installed as `centaur-consumer-<name>`, which a built-in
 * name can never equal), and returns the names it installed. Throws, naming the skill, for a
 * consumer skill that carries hooks, a plugin, a symbolic link or tools beyond `allowedTools`.
 */
export async function installSkills({
  home,
  sourceDir,
  consumerDir,
  allowedTools = [],
}: SkillInstall) {
  const installed: InstalledSkills = { builtin: [], consumer: [] };
  const target = join(home, ".claude", "skills");
  const stale = (await directories(target)).filter((e) => e.name.startsWith(BUILT_IN_PREFIX));
  await Promise.all(stale.map((e) => rm(join(target, e.name), { recursive: true, force: true })));
  await mkdir(target, { recursive: true });
  const copy = (from: string, name: string, to: string) =>
    cp(join(from, name), join(target, to), { recursive: true });
  if (sourceDir) {
    for (const { name } of await directories(sourceDir)) {
      await copy(sourceDir, name, name);
      installed.builtin.push(name);
    }
  }
  if (!consumerDir) return installed;
  for (const entry of await directories(consumerDir)) {
    const { name } = entry;
    const problem = entry.isSymbolicLink()
      ? "is a symbolic link"
      : await checkConsumerSkill(consumerDir, name, allowedTools);
    if (problem) throw new Error(`The consumer skill "${name}" ${problem}`);
    await copy(consumerDir, name, `${CONSUMER_SKILL_PREFIX}${name}`);
    installed.consumer.push(name);
  }
  return installed;
}
