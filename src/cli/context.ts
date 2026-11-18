import type { TelegramApi } from "../lambda/telegram.js";
import type { ParameterStore } from "./parameter-store.js";
import type { SecretReader } from "./secret-input.js";

export interface CliContext {
  store: ParameterStore;
  telegram: Pick<TelegramApi, "getMe">;
  readSecrets: SecretReader;
  log: (message: string) => void;
}
