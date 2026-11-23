export const requireEnv = (name: string, env: Record<string, string | undefined> = process.env) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
