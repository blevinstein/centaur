/**
 * The concurrency group of every turn job of a bot: chat messages, pull request comments and
 * scheduled prompts. One turn of a bot runs at a time; the rest wait in the group's queue
 * (`queue: max`). The name holds no chat or thread ID.
 */
export const botConcurrencyGroup = (bot: string) => `centaur-${bot}`;
