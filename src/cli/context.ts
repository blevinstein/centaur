import type { ParameterStore } from "./parameter-store.js";
import type { SecretReader } from "./secret-input.js";

export interface CliContext {
  store: ParameterStore;
  readSecrets: SecretReader;
  log: (message: string) => void;
}
