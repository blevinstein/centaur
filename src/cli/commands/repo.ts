import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { CliError } from "../registry.js";
import { stackVariables } from "../repo-vars.js";

interface VarsOptions {
  stack: string;
  repo?: string;
  org?: string;
  dryRun?: boolean;
}

const failure = (what: string, error: unknown) =>
  new CliError(`${what}: ${error instanceof Error ? error.message : String(error)}`);

async function resolveTarget(context: CliContext, { repo, org }: VarsOptions): Promise<string[]> {
  if (repo && org) throw new CliError("Pass --repo or --org, not both.");
  if (org) return ["--org", org, "--visibility", "all"];
  if (repo) return ["--repo", repo];
  const detected = await context
    .exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    .catch((error) => {
      throw failure("Not in a GitHub repository (pass --repo or --org)", error);
    });
  return ["--repo", detected.trim()];
}

export function registerRepoCommands(program: Command, context: CliContext): void {
  const repo = program.command("repo").description("Set up a consumer repo's GitHub Actions");

  repo
    .command("vars")
    .description(
      "Set the CENTAUR_* Actions variables from the deployed stack, on the current repo (needs the aws and gh CLIs)",
    )
    .option("--stack <name>", "CloudFormation stack name", "centaur")
    .option("--repo <owner/repo>", "repository to set them on (default: the current directory's)")
    .option("--org <org>", "set them organization-wide instead")
    .option("--dry-run", "print the variables without setting them")
    .action(async (options: VarsOptions) => {
      const target = await resolveTarget(context, options);
      const stack = await context
        .exec("aws", [
          "cloudformation",
          "describe-stacks",
          "--stack-name",
          options.stack,
          "--query",
          "Stacks[0]",
          "--output",
          "json",
        ])
        .catch((error) => {
          throw failure(`Cannot describe stack ${options.stack}`, error);
        });
      const variables = (() => {
        try {
          return stackVariables(JSON.parse(stack));
        } catch (error) {
          throw failure(`Stack ${options.stack} is not a Centaur stack`, error);
        }
      })();
      for (const [name, value] of Object.entries(variables)) {
        context.log(`${name}=${value}`);
        if (!options.dryRun) {
          await context
            .exec("gh", ["variable", "set", name, "--body", value, ...target])
            .catch((error) => {
              throw failure(`Cannot set ${name}`, error);
            });
        }
      }
    });
}
