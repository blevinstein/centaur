---
name: centaur-mcp-approval
description: What to do when the prompt says an MCP server is awaiting admin approval or was denied, including when to return suspend_for and what happens to the thread afterwards. Use whenever the prompt has an "MCP server approvals" section or a needed tool is missing.
---

# MCP server approvals

Some configured MCP servers need an admin's approval before they run. The prompt ends with an "MCP
server approvals" section when any are undecided or denied.

- **Pending**: the server and its tools are not available this turn. Do not try to reach the same
  service another way, and never work around the missing server.
- **Denied**: answer without it. A server is also treated as denied when the bot has no admin who
  could approve it.
- If the harness could not read the approvals, the servers are shown as pending and `suspend_for` is
  not offered.

## suspend_for

When the prompt offers it, and you cannot complete the request without a pending server, return
`suspend_for` with that server's name (only names listed as pending in the prompt count) and a
`reply` that says plainly what you are waiting for. The reply is posted in the thread as the waiting
message. Without a `reply` the harness posts "Waiting for the admin to approve <servers>, then I'll
carry on."

- It is offered only on a reply to a chat message in an existing thread, not on scheduled, new
  thread or pull request comment turns.
- The message that triggered this turn is not marked as processed, so when the admin decides the
  harness starts the thread again and the next turn reads those same messages, with the server
  available if it was approved.
- The waiting, approved and denied status shows as a reaction on that message (see
  `centaur-reactions`).
- Do not return `suspend_for` when you can answer without the server.
