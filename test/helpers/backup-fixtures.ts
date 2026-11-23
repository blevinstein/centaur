import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenParameter } from "../../src/lambda/connection-paths.js";
import { createCliHarness } from "./cli.js";
import { FakeParameterStore } from "./fake-parameter-store.js";

/** A store that drops every write to one parameter, so reading it back fails verification. */
export class LossyParameterStore extends FakeParameterStore {
  constructor(private readonly lossy: string) {
    super();
  }

  override async put(name: string, value: string, options: { secure: boolean }) {
    if (name !== this.lossy) await super.put(name, value, options);
  }
}

export const TOKEN_PARAMETER = tokenParameter("sample", "telegram");

export const backupPath = async () =>
  join(await mkdtemp(join(tmpdir(), "centaur-backup-")), "backup.json");

/** A bot with a telegram connection, access entries, a destination and a bound repo. */
export const populated = async () => {
  const cli = createCliHarness();
  await cli.connect("sample", "telegram", "tg-token");
  await cli.approveChat("sample", "telegram", "-100");
  await cli.store.put("/centaur/chats/telegram/household", '{"chatId":"-100"}', { secure: false });
  await cli.bind("sample", "owner/repo");
  return cli;
};
