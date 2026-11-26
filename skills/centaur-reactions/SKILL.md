---
name: centaur-reactions
description: What the emoji reactions on chat messages mean in this harness (👀 received, ⏳ waiting for MCP approval, ✅ approved, 🚫 denied) and why the agent cannot add or remove them. Use when a person asks about a reaction, or before claiming to have reacted.
---

# Reactions on chat messages

The harness, not the agent, puts reactions on the messages people send. You have no tool that adds,
removes or reads reactions, so never say you reacted or will react.

- 👀 means a message was accepted and a turn was started for it. It is not an answer. The harness
  removes it from the turn's messages after the reply is posted, and also when the turn fails.
- An MCP server that needs admin approval shows its status on the message that triggered the turn,
  after you suspend for it (see `centaur-mcp-approval`):

  | Status | Slack | Telegram |
  |---|---|---|
  | waiting for the admin | ⏳ | 🤔 |
  | approved | ✅ | 👍 |
  | denied | 🚫 | 👎 |

- A turn that suspends clears 👀 and leaves the waiting reaction; the admin's decision then replaces it.
- Removing a reaction is best-effort: a failure is logged and never fails the turn.
