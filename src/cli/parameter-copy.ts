import type { ParameterStore, StoredParameter } from "./parameter-store.js";
import { CliError } from "./registry.js";

export interface CopyPlan {
  source: StoredParameter;
  target: string;
}

export interface CopyClassification {
  /** Targets that do not exist yet. */
  missing: CopyPlan[];
  /** Targets that already hold the same value. */
  unchanged: CopyPlan[];
  /** Targets that exist with another value. */
  differing: CopyPlan[];
}

export async function classifyCopies(
  store: ParameterStore,
  plans: CopyPlan[],
): Promise<CopyClassification> {
  const classification: CopyClassification = { missing: [], unchanged: [], differing: [] };
  for (const plan of plans) {
    const existing = await store.get(plan.target);
    const bucket =
      existing === undefined
        ? classification.missing
        : existing === plan.source.value
          ? classification.unchanged
          : classification.differing;
    bucket.push(plan);
  }
  return classification;
}

/** Writes each target with the source's type, then reads it back; a mismatch aborts naming the parameter only. */
export async function writeVerified(store: ParameterStore, plans: CopyPlan[]): Promise<void> {
  for (const { source, target } of plans) {
    await store.put(target, source.value, { secure: source.secure });
    if ((await store.get(target)) !== source.value) {
      throw new CliError(`Verification failed: ${target} does not read back as written.`);
    }
  }
}
