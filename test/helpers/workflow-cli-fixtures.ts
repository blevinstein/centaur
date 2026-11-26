import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { runCli } from "../../src/workflows/program.js";

/** Set on the job by the caller workflow (`CENTAUR_*` repository variables), not by a composite action. */
export const CALLER_ENV = {
  CENTAUR_FUNCTION_NAME: "poster-fn",
  CENTAUR_OIDC_AUDIENCE: "centaur",
  CENTAUR_SESSION_BUCKET: "session-bucket",
};

/** A temp workspace and the runner-provided env that points at it. */
export async function createRunnerEnv(
  options: { files?: Record<string, string>; event?: unknown; env?: Record<string, string> } = {},
) {
  const { files = {}, event = {}, env = {} } = options;
  const base = await mkdtemp(join(tmpdir(), "centaur-cli-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace);
  for (const [path, text] of Object.entries(files)) await writeFile(join(workspace, path), text);
  await writeFile(join(base, "event.json"), JSON.stringify(event));
  const output = join(base, "output");
  await writeFile(output, "");
  return {
    workspace,
    output,
    env: {
      GITHUB_WORKSPACE: workspace,
      GITHUB_EVENT_PATH: join(base, "event.json"),
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "octo/sprout",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      RUNNER_TEMP: base,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token?api=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "bearer",
      ...CALLER_ENV,
      ...env,
    } as Record<string, string>,
  };
}

/** The values `writeOutputs` appended to a `GITHUB_OUTPUT` file. */
export async function readOutputs(file: string) {
  const outputs: Record<string, string> = {};
  for (const [, name, , value] of (await readFile(file, "utf8")).matchAll(
    /^(\w[\w-]*)<<(centaur_[\w-]+)\n([\s\S]*?)\n\2$/gm,
  )) {
    outputs[name as string] = value as string;
  }
  return outputs;
}

/** A `fetch` that answers the first route whose key the URL contains with that JSON, and fails any other request. */
export const stubFetch = (routes: Record<string, unknown> = {}) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = Object.keys(routes).find((key) => String(url).includes(key));
      if (!route) throw new Error(`unexpected request to ${url}`);
      return new Response(JSON.stringify(routes[route]));
    }),
  );

/** Runs one workflow command with exactly `env` (plus PATH and HOME) as its environment. */
export async function runWorkflowCommand(command: string, env: Record<string, string>) {
  const original = process.env;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env = { PATH: original.PATH, HOME: original.HOME, ...env };
  try {
    await runCli([command]);
    return {
      exitCode: process.exitCode,
      logs: log.mock.calls.map((call) => call.join(" ")),
      errors: error.mock.calls.map((call) => call.join(" ")),
    };
  } finally {
    process.env = original;
    process.exitCode = undefined;
    log.mockRestore();
    error.mockRestore();
  }
}
