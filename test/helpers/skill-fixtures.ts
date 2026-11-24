import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

export const skillText = (name: string, extra: Record<string, unknown> = {}) =>
  `---\n${stringify({ name, description: `Explains ${name}.`, ...extra })}---\nBody of ${name}.\n`;

/** Writes `files` (relative path to content) under a new temporary directory and returns it. */
export async function fileTree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "centaur-skills-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

export async function withSymlink(root: string, path: string, target: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await symlink(target, join(root, path));
  return root;
}

export const installedSkills = (home: string) =>
  readdir(join(home, ".claude", "skills")).then(
    (names) => names.toSorted(),
    () => [],
  );

export const BUILT_IN_FILES = {
  "centaur-alpha/SKILL.md": skillText("centaur-alpha"),
  "centaur-alpha/reference/detail.md": "Detail.\n",
  "centaur-beta/SKILL.md": skillText("centaur-beta"),
};

export const consumerSkill = (name: string, extra: Record<string, unknown> = {}) => ({
  [`${name}/SKILL.md`]: skillText(name, extra),
});

/** Consumer skill trees the install must refuse, with the text the failure must contain. */
export const rejectedConsumerSkills: [
  name: string,
  files: Record<string, string>,
  allowedTools: string[],
  message: RegExp,
][] = [
  [
    "hooks in the frontmatter",
    consumerSkill("deploy", { hooks: { PreToolUse: [] } }),
    ["Read"],
    /skill "deploy".*hooks/,
  ],
  [
    "a plugin manifest folder",
    { ...consumerSkill("deploy"), "deploy/.claude-plugin/plugin.json": "{}" },
    ["Read"],
    /skill "deploy".*\.claude-plugin/,
  ],
  [
    "allowed-tools outside allowed_tools",
    consumerSkill("deploy", { "allowed-tools": "Read Bash" }),
    ["Read"],
    /skill "deploy".*Bash/,
  ],
  [
    "a list of allowed-tools outside allowed_tools",
    consumerSkill("deploy", { "allowed-tools": ["Read", "Bash(git push *)"] }),
    ["Read"],
    /skill "deploy".*Bash\(git push \*\)/,
  ],
  [
    "a name that differs from the folder",
    { "deploy/SKILL.md": skillText("release") },
    ["Read"],
    /skill "deploy".*name/,
  ],
  [
    "no frontmatter",
    { "deploy/SKILL.md": "Just text.\n" },
    ["Read"],
    /skill "deploy".*frontmatter/,
  ],
  [
    "a folder without SKILL.md",
    { "deploy/notes.md": "Notes.\n" },
    ["Read"],
    /skill "deploy".*SKILL\.md/,
  ],
  [
    "the reserved built-in prefix",
    consumerSkill("centaur-alpha"),
    ["Read"],
    /skill "centaur-alpha".*reserved/,
  ],
];

/** A consumer skill as a repository commits it, for a workspace or trusted checkout fixture. */
export const repositorySkill = (name: string, extra: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries(consumerSkill(name, extra)).map(([path, text]) => [
      `.claude/skills/${path}`,
      text,
    ]),
  );
