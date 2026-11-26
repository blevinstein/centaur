export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const firstLine = (value: string, max: number) =>
  value.trim().split("\n")[0]?.slice(0, max) ?? "";
