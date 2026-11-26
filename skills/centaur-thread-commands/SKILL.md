---
name: centaur-thread-commands
description: How the chat commands /new, /resume and /transcript and the thread's context policy (fresh, transcript, resume) change what the agent sees and where its reply goes. Use when the prompt shows earlier messages that look cut off, a missing history, or when a person asks about these commands.
---

# Thread commands and context policy

On Telegram (Slack does not support these commands; its threads use the prompt's `context`), a
message that starts with `/new`, `/resume` or `/transcript` (also `/cmd@bot`, any case) is a
command for the harness. The command word is removed from the new messages you see; any text after
it is an ordinary message.

- `/new [text]` starts a new thread in the same chat. The current thread gets "Started a new
  thread." and your reply goes to the new thread, which is seeded with the text and any later
  pending messages. A bare `/new` opens an empty thread and runs no agent turn.
- `/resume` and `/transcript` set the thread's context policy for this and later turns. A message
  that holds only such a command is acknowledged ("Context policy for this thread: ...") without a
  turn.

## What you see per policy

| Policy | Earlier messages | Session |
|---|---|---|
| `fresh` | not shown | none |
| `transcript` | shown before the new messages, up to `context.transcript_max_chars` | none |
| `resume` | not shown when your previous session is restored; shown like `transcript` when it is not | restored and saved after the turn |

The policy is the latest `/resume` or `/transcript` a person used in the thread (Telegram), else the one stored
on the thread, else the config's `context.default`.

When the budget leaves messages out, the transcript says how many and whether they can be fetched;
older messages are reachable only with the chat tools (see `centaur-chat-tools`).
