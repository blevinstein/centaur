import { z } from "zod";
import { BOTS_ROOT } from "../lambda/connection-paths.js";
import { CHATS_PREFIX, PARAMETER_ROOT } from "../lambda/parameters.js";
import type { ParameterStore, StoredParameter } from "./parameter-store.js";
import { CliError } from "./registry.js";

export const BACKUP_FORMAT_VERSION = 1;

/** The parameter trees a backup covers: bots, chats, and the admin and pending claims. */
const BACKUP_ROOTS = [
  `${BOTS_ROOT}/`,
  `${CHATS_PREFIX}/`,
  `${PARAMETER_ROOT}/admin/`,
  `${PARAMETER_ROOT}/admin-claim/`,
];

const inBackupScope = (name: string) => BACKUP_ROOTS.some((root) => name.startsWith(root));

const backupSchema = z.strictObject({
  version: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: z.string(),
  parameters: z.array(z.strictObject({ name: z.string(), value: z.string(), secure: z.boolean() })),
});

export type Backup = z.infer<typeof backupSchema>;

export async function buildBackup(store: ParameterStore, now = new Date()): Promise<Backup> {
  const roots = await Promise.all(BACKUP_ROOTS.map((root) => store.getByPath(root)));
  const parameters: StoredParameter[] = roots.flat().sort((a, b) => a.name.localeCompare(b.name));
  return { version: BACKUP_FORMAT_VERSION, exportedAt: now.toISOString(), parameters };
}

export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError("The backup file is not valid JSON.");
  }
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      `The backup file is not a version ${BACKUP_FORMAT_VERSION} Centaur backup: ${parsed.error.issues[0]?.message}`,
    );
  }
  const stray = parsed.data.parameters.find(({ name }) => !inBackupScope(name));
  if (stray) throw new CliError(`The backup holds a parameter outside its scope: ${stray.name}`);
  return parsed.data;
}
