import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTBOUND_FILE_BYTES, OUTBOUND_TOTAL_BYTES } from "../../src/poster-contract.js";
import { createWorkspace } from "./workflow-fixtures.js";

export const PNG = "png-bytes";
export const OPT_IN = "attachments: { outbound: true }";

/** A few attachable files and every kind of file that must stay out. */
export const OUTBOUND_FILES = {
  "chart.png": PNG,
  "out/notes.txt": "notes",
  "empty.txt": "",
  ".env": "SECRET=1",
  ".git/config": "[credential]",
  ".centaur-turn/prompt.md": "prompt",
  "half-a.bin": "y".repeat(OUTBOUND_TOTAL_BYTES * 0.6),
  "half-b.bin": "z".repeat(OUTBOUND_TOTAL_BYTES * 0.6),
  "big.bin": "x".repeat(OUTBOUND_FILE_BYTES + 1),
};

/** Adds symlinks to `root`: one out of it, one to a hidden file and one to an attachable file. */
export async function linkOutboundFiles(root: string) {
  const outside = await mkdtemp(join(tmpdir(), "centaur-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  await symlink(join(root, ".env"), join(root, "env-link.txt"));
  await symlink(join(root, "chart.png"), join(root, "alias.png"));
}

export async function outboundWorkspace() {
  const { root } = await createWorkspace(OUTBOUND_FILES);
  await linkOutboundFiles(root);
  return root;
}

export const base64 = (text: string) => Buffer.from(text).toString("base64");
