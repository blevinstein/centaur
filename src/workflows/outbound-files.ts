import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  OUTBOUND_FILE_BYTES,
  OUTBOUND_FILES_MAX,
  OUTBOUND_TOTAL_BYTES,
  type OutboundFile,
  outboundFileSchema,
} from "../poster-contract.js";

export interface OutboundFiles {
  files: OutboundFile[];
  /** How many named files were dropped; never which, or why. */
  skipped: number;
}

/** A hidden segment covers `.git`, the turn directory, the trusted checkout and dotfiles such as `.env`. */
const hasHiddenSegment = (path: string) =>
  path.split(sep).some((segment) => segment.startsWith("."));

/**
 * The workspace-relative path of a file the agent may attach, or undefined. The real path (after
 * symlinks) must be a regular file inside the real workspace with no hidden segment, so neither
 * `..`, an absolute path nor a symlink reaches anything the agent could not already commit.
 */
async function resolveInside(workspace: string, name: string) {
  if (isAbsolute(name) || name.includes("\0")) return undefined;
  const root = await realpath(workspace);
  const real = await realpath(join(root, name));
  const inside = relative(root, real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside) || hasHiddenSegment(inside)) {
    return undefined;
  }
  if (hasHiddenSegment(relative(root, join(root, name)))) return undefined;
  return (await stat(real)).isFile() ? real : undefined;
}

/** Reads the named workspace files within the per-file, per-reply and count limits; the rest are skipped. */
export async function readOutboundFiles(
  workspace: string,
  names: string[],
): Promise<OutboundFiles> {
  const files: OutboundFile[] = [];
  let total = 0;
  for (const name of names.slice(0, OUTBOUND_FILES_MAX)) {
    try {
      const real = await resolveInside(workspace, name);
      const { size } = real ? await stat(real) : { size: 0 };
      if (!real || size === 0 || size > OUTBOUND_FILE_BYTES) continue;
      if (total + size > OUTBOUND_TOTAL_BYTES) continue;
      const file = outboundFileSchema.safeParse({
        filename: basename(real),
        data: (await readFile(real)).toString("base64"),
      });
      if (!file.success) continue;
      total += size;
      files.push(file.data);
    } catch {}
  }
  return { files, skipped: names.length - files.length };
}
