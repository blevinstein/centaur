/** Hands out stable `<prefix>-<n>` aliases for real values that must not reach the agent. */
export class OpaqueIds {
  private readonly byAlias = new Map<string, string>();
  private readonly byValue = new Map<string, string>();
  private next = 1;

  constructor(private readonly prefix: string) {}

  alias(value: string) {
    const existing = this.byValue.get(value);
    if (existing) return existing;
    const alias = `${this.prefix}-${this.next++}`;
    this.pin(alias, value);
    return alias;
  }

  /** Registers a value under an alias chosen by the caller. */
  pin(alias: string, value: string) {
    this.byValue.set(value, alias);
    this.byAlias.set(alias, value);
  }

  resolve(alias: string) {
    return this.byAlias.get(alias);
  }
}
