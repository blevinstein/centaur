import { z } from "zod";
import { cleanTitle } from "./workflows/clean-text.js";

export const MAX_IDENTITY_LENGTH = 64;

const MARKUP_CHARACTERS = /[`"\\<>[\]]/g;

const cleanName = (text: string) =>
  cleanTitle(text).replaceAll(MARKUP_CHARACTERS, "").trim().slice(0, MAX_IDENTITY_LENGTH).trim();

const name = z.string().transform(cleanName).pipe(z.string().min(1));

/**
 * How the bot is known on its platform. Both names are chosen by whoever administers the Slack app
 * or Telegram bot, so parsing reduces them to a short single line without quotes or markup.
 */
export const selfIdentitySchema = z.object({ username: name, display_name: name });

export type SelfIdentity = z.infer<typeof selfIdentitySchema>;

/** The cleaned identity, or undefined when no usable username remains; a missing display name is the username. */
export function toSelfIdentity(username: string, displayName = ""): SelfIdentity | undefined {
  const user = name.safeParse(username);
  if (!user.success) return undefined;
  const display = name.safeParse(displayName);
  return { username: user.data, display_name: display.success ? display.data : user.data };
}
