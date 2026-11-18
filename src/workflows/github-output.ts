import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";

export async function writeOutputs(file: string, values: Record<string, string>) {
  const delimiter = `centaur_${randomUUID()}`;
  const body = Object.entries(values)
    .map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
    .join("");
  await appendFile(file, body);
}

export const maskValue = (value: string) => console.log(`::add-mask::${value}`);
