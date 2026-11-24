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
  approver: z.string().optional(),
  at: z.string(),
});
export type AccessEntry = z.infer<typeof entrySchema>;

export const encodeEntry = (
  {
    name,
    alias,
    approver,
  }: { name?: string | undefined; alias?: string | undefined; approver?: string | undefined } = {},
  at = new Date(),
) =>
  JSON.stringify({
    ...(name ? { name } : {}),
    ...(alias ? { alias } : {}),
    ...(approver ? { approver } : {}),
    at: at.toISOString(),
  });

/** The entry a value encodes, or undefined when it is not a valid entry. */
export function parseEntry(value: string): AccessEntry | undefined {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {}
  return undefined;
}

export const decodeEntry = (value: string): AccessEntry => parseEntry(value) ?? { at: "unknown" };
