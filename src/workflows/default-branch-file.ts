import { posix } from "node:path";
import { formatIssues, isRepoRelativePath, parseCentaurConfig } from "../config/index.js";
import { CONFIG_FILES } from "./config-file.js";
import { fetchDefaultBranch, GitHubRequestError, type GitHubRequester } from "./resolve.js";

/** The repo-relative path of a file under a Centaur root, as a URL path. */
export function repoFilePath(root: string, file: string): string {
  if (!isRepoRelativePath(root)) {
    throw new Error(`Invalid Centaur root "${root}": must be a relative path inside the repo`);
  }
  return posix.join(root, file).split("/").map(encodeURIComponent).join("/");
}

/** Reads a file from the default branch, never a checkout; `undefined` when it does not exist. */
export async function fetchDefaultBranchFile(
  github: GitHubRequester,
  repository: string,
  root: string,
  file: string,
): Promise<string | undefined> {
  const defaultBranch = await fetchDefaultBranch(github, repository);
  try {
    return await github.text(
      `/repos/${repository}/contents/${repoFilePath(root, file)}?ref=${encodeURIComponent(defaultBranch)}`,
      "application/vnd.github.raw+json",
    );
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) return undefined;
    throw error;
  }
}

/** The one Centaur config on the default branch, parsed; having both files or neither is an error. */
export async function fetchDefaultBranchConfig(
  github: GitHubRequester,
  repository: string,
  root = ".",
) {
  const texts = (
    await Promise.all(
      CONFIG_FILES.map((file) => fetchDefaultBranchFile(github, repository, root, file)),
    )
  ).filter((text) => text !== undefined);
  if (texts.length !== 1) {
    throw new Error(
      `Expected exactly one of ${CONFIG_FILES.join(" or ")} on the default branch of ${repository}, found ${texts.length}`,
    );
  }
  const result = parseCentaurConfig(texts[0] as string);
  if (!result.ok) throw new Error(`The Centaur config is invalid:\n${formatIssues(result.issues)}`);
  return result.config;
}
