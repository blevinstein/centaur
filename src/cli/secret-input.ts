import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export type SecretReader = (names: readonly string[]) => Promise<Record<string, string>>;

const envName = (name: string) => `CENTAUR_BOT_${name.toUpperCase().replaceAll("-", "_")}`;

async function readStdinLines(count: number): Promise<string[]> {
  const lines: string[] = [];
  if (count === 0) return lines;
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    lines.push(line.trim());
    if (lines.length === count) break;
  }
  rl.close();
  return lines;
}

async function promptHidden(label: string): Promise<string> {
  process.stderr.write(`${label}: `);
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  const answer = await rl.question("");
  rl.close();
  process.stderr.write("\n");
  return answer.trim();
}

export const readSecretsFromEnvOrInput: SecretReader = async (names) => {
  const values: Record<string, string> = {};
  const pending: string[] = [];
  for (const name of names) {
    const fromEnv = process.env[envName(name)];
    if (fromEnv) values[name] = fromEnv.trim();
    else pending.push(name);
  }
  if (process.stdin.isTTY) {
    for (const name of pending) values[name] = await promptHidden(name);
  } else {
    const lines = await readStdinLines(pending.length);
    for (const [i, name] of pending.entries()) values[name] = lines[i] ?? "";
  }
  for (const name of names) {
    if (!values[name]) throw new Error(`Missing value for ${name}.`);
  }
  return values;
};
