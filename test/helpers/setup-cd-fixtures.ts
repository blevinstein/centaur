import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "setup-cd.sh");

const STUB = `#!/usr/bin/env bash
name="$(basename "$0")"
printf '%s\\n' "$name $*" >> "$STUB_DIR/calls.log"
case "$*" in *"--input -"*|*"secret set"*) cat >> "$STUB_DIR/stdin.log" ;; esac
key="$(printf '%s' "$name $1 $2" | tr -c 'A-Za-z0-9\\n' _)"
n=$(($(grep -c -x "$name $1 $2.*" "$STUB_DIR/calls.log") ))
k=$(ls "$STUB_DIR/resp" 2>/dev/null | grep -c "^$key\\.[0-9]*$" || true)
[ "$k" -gt 0 ] || exit 0
[ "$n" -le "$k" ] || n=$k
cat "$STUB_DIR/resp/$key.$n"
exit "$(cat "$STUB_DIR/resp/$key.$n.rc")"
`;

export const repo = "o/r";
export const envPath = `repos/${repo}/environments/production`;
export const secretMarker = "S3CRET-VALUE-1234";
export const validParams = [
  { ParameterKey: "GitHubOwner", ParameterValue: "someone" },
  { ParameterKey: "OidcAudience", ParameterValue: secretMarker },
];

type Reply = { stdout?: string; rc?: number };
export const ok = (stdout = ""): Reply => ({ stdout, rc: 0 });
export const missing: Reply = { stdout: "", rc: 1 };
export const environmentJson = ok('{"deployment_branch_policy":{"custom_branch_policies":true}}');
export const policiesJson = (...names: string[]) =>
  ok(JSON.stringify({ branch_policies: names.map((name) => ({ name })) }));
export const variablesJson = (...names: string[]) =>
  ok(JSON.stringify(names.map((name) => ({ name }))));

export async function createSetupCd() {
  const dir = await mkdtemp(join(tmpdir(), "setup-cd-"));
  const bin = join(dir, "bin");
  await mkdir(join(dir, "resp"), { recursive: true });
  await mkdir(bin);
  for (const name of ["gh", "aws"]) {
    await writeFile(join(bin, name), STUB);
    await chmod(join(bin, name), 0o755);
  }
  await writeFile(join(dir, "calls.log"), "");
  await writeFile(join(dir, "stdin.log"), "");
  const paramsFile = join(dir, "parameters-prod.json");
  await writeFile(paramsFile, JSON.stringify(validParams, null, 2));

  /** Replies to successive calls of `<tool> <a> <b>`; the last reply repeats. */
  const respond = async (tool: string, a: string, b: string, ...replies: Reply[]) => {
    const key = `${tool} ${a} ${b}`.replace(/[^A-Za-z0-9]/g, "_");
    for (const [i, reply] of replies.entries()) {
      await writeFile(join(dir, "resp", `${key}.${i + 1}`), reply.stdout ?? "");
      await writeFile(join(dir, "resp", `${key}.${i + 1}.rc`), String(reply.rc ?? 0));
    }
  };
  const run = (args: string[]) => {
    const result = spawnSync(SCRIPT, [...args, "--repo", repo, "--params-file", paramsFile], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const calls = async () =>
    (await readFile(join(dir, "calls.log"), "utf8")).split("\n").filter(Boolean);
  const stdin = () => readFile(join(dir, "stdin.log"), "utf8");
  const stackArn = (arn = "arn:aws:iam::1:role/centaur-DeployRole-x") => ok(`${arn}\n`);

  /** The state of a fully set-up repository and stack; tests override one piece. */
  const respondReady = async () => {
    await respond("aws", "cloudformation", "describe-stacks", stackArn());
    await respond("gh", "api", envPath, environmentJson);
    await respond("gh", "api", `${envPath}/deployment-branch-policies`, policiesJson("main"));
    await respond("gh", "variable", "list", variablesJson("CENTAUR_AWS_REGION"));
  };
  return { run, calls, stdin, respond, respondReady, paramsFile, stackArn };
}
