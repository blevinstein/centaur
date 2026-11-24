import type { TelegramApi } from "../lambda/telegram.js";
import type { Exec } from "../workflows/aws.js";
import type { ChatAccess } from "./chat-access.js";
import type { ParameterStore } from "./parameter-store.js";
import type { SecretReader } from "./secret-input.js";

export interface CliContext {
  store: ParameterStore;
  telegram: Pick<TelegramApi, "getMe">;
  chatAccess: ChatAccess;
  readSecrets: SecretReader;
  exec: Exec;
  log: (message: string) => void;
}
