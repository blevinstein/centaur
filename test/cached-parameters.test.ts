import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { adminParameter } from "../src/lambda/access-entries.js";
import { adminClaimParameter } from "../src/lambda/admin-claim-record.js";
import {
  createCachedParameterStore,
  PARAMETER_CACHE_TTL_MS,
} from "../src/lambda/cached-parameters.js";
import {
  approvedParameter,
  approvedPrefix,
  tokenParameter,
} from "../src/lambda/connection-paths.js";
import type { ParameterStore } from "../src/lambda/parameters.js";
import { fakeParameterStore } from "./helpers/receiver-fixtures.js";

const NAME = adminParameter("telegram");

describe("createCachedParameterStore", () => {
  let clock: number;
  let inner: ReturnType<typeof fakeParameterStore>;
  let getSpy: Mock<ParameterStore["get"]>;
  let store: ReturnType<typeof createCachedParameterStore>;

  beforeEach(() => {
    clock = 0;
    const base = fakeParameterStore({ [NAME]: "1001", [adminClaimParameter("telegram")]: "c" });
    getSpy = vi.fn<ParameterStore["get"]>(base.get);
    inner = { ...base, get: getSpy };
    store = createCachedParameterStore(inner, { now: () => clock });
  });

  it("serves repeated reads from the cache until the TTL expires", async () => {
    expect(await store.get(NAME)).toBe("1001");
    expect(await store.get(NAME)).toBe("1001");
    expect(getSpy).toHaveBeenCalledTimes(1);

    clock = PARAMETER_CACHE_TTL_MS;
    inner.values[NAME] = "2002";
    expect(await store.get(NAME)).toBe("2002");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["put", () => store.put(NAME, "2002")],
    ["delete", () => store.delete(NAME)],
  ])("reads fresh after %s", async (_, write) => {
    await store.get(NAME);
    await write();
    await store.get(NAME);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("reads fresh after putIfAbsent", async () => {
    await store.get(NAME);
    expect(await store.putIfAbsent(NAME, "2002")).toBe(false);
    await store.get(NAME);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache missing parameters", async () => {
    expect(await store.get("/centaur/missing")).toBeUndefined();
    inner.values["/centaur/missing"] = "now here";
    expect(await store.get("/centaur/missing")).toBe("now here");
  });

  it("caches connection secrets but never lists a path from the cache", async () => {
    const token = tokenParameter("garden", "telegram");
    const approvedUsers = approvedPrefix("garden", "telegram", "user");
    const listSpy = vi.fn<ParameterStore["getByPath"]>(inner.getByPath);
    const listing = createCachedParameterStore(
      { ...inner, getByPath: listSpy },
      { now: () => clock },
    );
    inner.values[token] = "tg-token";

    await store.get(token);
    await store.get(token);
    expect(getSpy).toHaveBeenCalledTimes(1);

    expect(await listing.getByPath(approvedUsers)).toEqual({});
    inner.values[approvedParameter("garden", "telegram", "user", "1001")] = "{}";
    expect(Object.keys(await listing.getByPath(approvedUsers))).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it("never caches admin claims", async () => {
    const claim = adminClaimParameter("telegram");
    await store.get(claim);
    await store.get(claim);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
