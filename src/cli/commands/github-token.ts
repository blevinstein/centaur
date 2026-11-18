import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { CliError, GITHUB_TOKEN_PARAMETER } from "../registry.js";

export function registerGithubTokenCommands(program: Command, context: CliContext): void {
  const githubToken = program
    .command("github-token")
    .description("Manage the GitHub token the receiver uses to dispatch workflows");

  githubToken
    .command("set")
    .description("Store the token in SSM (read from env, stdin, or a hidden prompt)")
    .action(async () => {
      const { "github-token": token } = await context.readSecrets(["github-token"]);
      await context.store.put(GITHUB_TOKEN_PARAMETER, token as string, { secure: true });
      context.log("Stored the GitHub token.");
    });

  githubToken
    .command("remove")
    .description("Delete the token from SSM")
    .action(async () => {
      if (!(await context.store.get(GITHUB_TOKEN_PARAMETER))) {
        throw new CliError("No GitHub token is stored.");
      }
      await context.store.delete([GITHUB_TOKEN_PARAMETER]);
      context.log("Removed the GitHub token.");
    });
}
