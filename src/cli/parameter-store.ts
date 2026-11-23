import {
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

export interface ParameterStore {
  get(name: string): Promise<string | undefined>;
  put(name: string, value: string, options: { secure: boolean }): Promise<void>;
  listNames(prefix: string): Promise<string[]>;
  /** Every parameter under the prefix, decrypted, with its type. */
  getByPath(prefix: string): Promise<StoredParameter[]>;
  delete(names: string[]): Promise<void>;
}

export interface StoredParameter {
  name: string;
  value: string;
  secure: boolean;
}

const DELETE_BATCH_SIZE = 10;

export class SsmParameterStore implements ParameterStore {
  constructor(private readonly client = new SSMClient({})) {}

  async get(name: string): Promise<string | undefined> {
    try {
      const { Parameter } = await this.client.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      return Parameter?.Value;
    } catch (error) {
      if (error instanceof ParameterNotFound) return undefined;
      throw error;
    }
  }

  async put(name: string, value: string, { secure }: { secure: boolean }): Promise<void> {
    await this.client.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: secure ? "SecureString" : "String",
        Overwrite: true,
      }),
    );
  }

  async listNames(prefix: string): Promise<string[]> {
    const parameters = await this.fetchByPath(prefix, false);
    return parameters.map(({ name }) => name);
  }

  getByPath(prefix: string): Promise<StoredParameter[]> {
    return this.fetchByPath(prefix, true);
  }

  private async fetchByPath(prefix: string, decrypt: boolean): Promise<StoredParameter[]> {
    const found: StoredParameter[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new GetParametersByPathCommand({
          Path: prefix,
          Recursive: true,
          WithDecryption: decrypt,
          NextToken: nextToken,
        }),
      );
      for (const { Name, Value, Type } of page.Parameters ?? []) {
        if (Name) found.push({ name: Name, value: Value ?? "", secure: Type === "SecureString" });
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return found;
  }

  async delete(names: string[]): Promise<void> {
    for (let i = 0; i < names.length; i += DELETE_BATCH_SIZE) {
      await this.client.send(
        new DeleteParametersCommand({ Names: names.slice(i, i + DELETE_BATCH_SIZE) }),
      );
    }
  }
}
