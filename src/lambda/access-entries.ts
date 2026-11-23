import { z } from "zod";
import { PARAMETER_ROOT } from "./parameters.js";

export const ACCESS_KINDS = ["chat", "user"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

export const adminParameter = (platform: string) => `${PARAMETER_ROOT}/admin/${platform}`;

export const subjectIdOf = (parameterName: string) =>
  parameterName.slice(parameterName.lastIndexOf("/") + 1);

const entrySchema = z.object({
  name: z.string().optional(),
  alias: z.string().optional(),
  at: z.string(),
});
export type AccessEntry = z.infer<typeof entrySchema>;

export const encodeEntry = (
  { name, alias }: { name?: string | undefined; alias?: string | undefined } = {},
  at = new Date(),
) =>
  JSON.stringify({
    ...(name ? { name } : {}),
    ...(alias ? { alias } : {}),
    at: at.toISOString(),
  });

export function decodeEntry(value: string): AccessEntry {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {}
  return { at: "unknown" };
}
