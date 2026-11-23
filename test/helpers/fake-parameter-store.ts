import type { ParameterStore } from "../../src/cli/parameter-store.js";

export class FakeParameterStore implements ParameterStore {
  readonly entries = new Map<string, { value: string; secure: boolean }>();

  async get(name: string) {
    return this.entries.get(name)?.value;
  }

  async put(name: string, value: string, { secure }: { secure: boolean }) {
    this.entries.set(name, { value, secure });
  }

  async listNames(prefix: string) {
    return [...this.entries.keys()].filter((name) => name.startsWith(prefix));
  }

  async getByPath(prefix: string) {
    return [...this.entries]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, { value, secure }]) => ({ name, value, secure }));
  }

  async delete(names: string[]) {
    for (const name of names) this.entries.delete(name);
  }

  names() {
    return [...this.entries.keys()].sort();
  }
}
