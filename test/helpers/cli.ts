import type { CliContext } from "../../src/cli/context.js";
import { buildProgram } from "../../src/cli/program.js";
import type { SecretReader } from "../../src/cli/secret-input.js";
import { FakeParameterStore } from "./fake-parameter-store.js";

export function createCliHarness(
  secrets: Record<string, string> = {},
  telegram: CliContext["telegram"] = { getMe: async () => ({ username: "garden_bot" }) },
) {
  const store = new FakeParameterStore();
  const output: string[] = [];
  const readSecrets: SecretReader = async (names) =>
    Object.fromEntries(names.map((name) => [name, secrets[name] ?? ""]));
  const program = buildProgram({
    store,
    telegram,
    readSecrets,
    log: (message) => output.push(message),
  });
  return {
    store,
    output,
    run: (...args: string[]) => program.parseAsync(args, { from: "user" }),
  };
}
