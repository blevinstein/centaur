import { describe, expect, it } from "vitest";
import { hasChanges } from "../src/workflows/push.js";
import { commitFile, createClone } from "./helpers/git-fixtures.js";

describe("hasChanges", () => {
  it("is false for a clean workspace", async () => {
    const { work } = await createClone();

    await expect(hasChanges(work)).resolves.toBe(false);
  });

  it("is false when only .centaur-turn or .centaur-trusted changed, excluded or not", async () => {
    for (const ignoreTurnDir of [true, false]) {
      const { work, write } = await createClone({ ignoreTurnDir });
      await write(".centaur-turn/prompt.md", "secret\n");
      await write(".centaur-trusted/config.yml", "secret\n");

      await expect(hasChanges(work)).resolves.toBe(false);
    }
  });

  it("is true for an edited or new file", async () => {
    const { work, write } = await createClone();
    await write("new.md", "hello\n");

    await expect(hasChanges(work)).resolves.toBe(true);
  });

  it("is true for a clean workspace with commits ahead of its upstream", async () => {
    const { work } = await createClone();
    await commitFile(work, "new.md", "hello\n");

    await expect(hasChanges(work)).resolves.toBe(true);
  });
});
