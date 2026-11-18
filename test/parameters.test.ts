import { ParameterAlreadyExists, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import { createSsmParameterStore } from "../src/lambda/parameters.js";

const storeWith = (send: (command: PutParameterCommand) => Promise<unknown>) => {
  const client = { send: vi.fn(send) } as unknown as SSMClient;
  return { store: createSsmParameterStore(client), send: client.send as ReturnType<typeof vi.fn> };
};

describe("putIfAbsent", () => {
  it("writes without overwriting and reports the creation", async () => {
    const { store, send } = storeWith(async () => ({}));

    expect(await store.putIfAbsent("/centaur/chats/a", "-1")).toBe(true);

    const [command] = send.mock.calls[0] as [PutParameterCommand];
    expect(command).toBeInstanceOf(PutParameterCommand);
    expect(command.input).toMatchObject({
      Name: "/centaur/chats/a",
      Value: "-1",
      Overwrite: false,
    });
  });

  it("reports false when the parameter exists", async () => {
    const { store } = storeWith(async () => {
      throw new ParameterAlreadyExists({ message: "exists", $metadata: {} });
    });

    expect(await store.putIfAbsent("/centaur/chats/a", "-1")).toBe(false);
  });

  it("rethrows any other failure", async () => {
    const { store } = storeWith(async () => {
      throw new Error("throttled");
    });

    await expect(store.putIfAbsent("/centaur/chats/a", "-1")).rejects.toThrow("throttled");
  });
});
