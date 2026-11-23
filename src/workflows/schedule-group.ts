import type { CentaurConfig } from "../config/index.js";
import { threadKey } from "../thread-key.js";

/**
 * The concurrency group of a scheduled prompt's turn job. Runs of a `thread: persistent` prompt
 * share one group per bot and set of destinations, so they never interleave in a thread. The key
 * hashes the platform and destination names, not any chat or thread ID. Any other prompt gets a
 * group of its own per run, which serializes nothing.
 */
export function scheduleGroup(config: CentaurConfig, promptName: string, runId: string) {
  const prompt = config.prompts[promptName];
  if (!prompt) throw new Error(`The Centaur config defines no prompt named "${promptName}"`);
  if (prompt.thread !== "persistent") return `centaur-${config.bot}-${promptName}-${runId}`;
  const destinations = prompt.targets
    .map((target) => `${target.platform}/${target.destination}`)
    .sort()
    .join(",");
  return `centaur-${config.bot}-${threadKey(config.bot, destinations)}`;
}
