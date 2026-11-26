import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CentaurConfig } from "../config/index.js";

export const INSTRUCTION_KINDS = ["chat", "chat_tools", "comment", "silence"] as const;

export type Instructions = Record<(typeof INSTRUCTION_KINDS)[number], string>;

const bundled = (kind: keyof Instructions) =>
  readFileSync(new URL(`./instructions/${kind}.md`, import.meta.url), "utf8").trim();

export const DEFAULT_INSTRUCTIONS: Instructions = {
  chat: bundled("chat"),
  chat_tools: bundled("chat_tools"),
  comment: bundled("comment"),
  silence: bundled("silence"),
};

export async function loadInstructions(
  dir: string,
  overrides: CentaurConfig["instructions"],
): Promise<Instructions> {
  const entries = await Promise.all(
    INSTRUCTION_KINDS.map(async (kind) => {
      const path = overrides[kind];
      if (!path) return [kind, DEFAULT_INSTRUCTIONS[kind]] as const;
      const text = (await readFile(join(dir, path), "utf8")).trim();
      if (!text) throw new Error(`instructions.${kind} (${path}) is empty`);
      return [kind, text] as const;
    }),
  );
  return Object.fromEntries(entries) as Instructions;
}
