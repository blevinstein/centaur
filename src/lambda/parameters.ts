import {
  GetParameterCommand,
  ParameterNotFound,
  paginateGetParametersByPath,
  SSMClient,
} from "@aws-sdk/client-ssm";

export const PARAMETER_ROOT = "/centaur";

export interface ParameterStore {
  get(name: string): Promise<string | undefined>;
  getByPath(path: string): Promise<Record<string, string>>;
}

export const botParameter = (bot: string, key: string) => `${PARAMETER_ROOT}/bots/${bot}/${key}`;
export const userParameter = (name: string, platform: string) =>
  `${PARAMETER_ROOT}/users/${name}/${platform}`;
export const chatParameter = (name: string) => `${PARAMETER_ROOT}/chats/${name}`;
export const GITHUB_TOKEN_PARAMETER = `${PARAMETER_ROOT}/github/token`;

export function createSsmParameterStore(client = new SSMClient({})): ParameterStore {
  const getByPath = async (path: string) => {
    const found: Record<string, string> = {};
    const pages = paginateGetParametersByPath(
      { client },
      { Path: path, Recursive: true, WithDecryption: true },
    );
    for await (const page of pages) {
      for (const { Name, Value } of page.Parameters ?? []) {
        if (Name !== undefined && Value !== undefined) found[Name] = Value;
      }
    }
    return found;
  };
  return {
    getByPath,
    get: async (name) => {
      try {
        const { Parameter } = await client.send(
          new GetParameterCommand({ Name: name, WithDecryption: true }),
        );
        return Parameter?.Value;
      } catch (error) {
        if (error instanceof ParameterNotFound) return undefined;
        throw error;
      }
    },
  };
}
