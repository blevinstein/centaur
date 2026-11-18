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
  delete(names: string[]): Promise<void>;
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
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new GetParametersByPathCommand({ Path: prefix, Recursive: true, NextToken: nextToken }),
      );
      for (const parameter of page.Parameters ?? []) {
        if (parameter.Name) names.push(parameter.Name);
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return names;
  }

  async delete(names: string[]): Promise<void> {
    for (let i = 0; i < names.length; i += DELETE_BATCH_SIZE) {
      await this.client.send(
        new DeleteParametersCommand({ Names: names.slice(i, i + DELETE_BATCH_SIZE) }),
      );
    }
  }
}
