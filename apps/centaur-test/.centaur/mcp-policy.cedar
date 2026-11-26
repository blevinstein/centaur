// Remote GitHub MCP server, read-only endpoints only. The /readonly URLs are enforced by the
// server, so the agent cannot reach a write tool even if allowed_tools names one. The server is
// used once the admin (or an approver) approves it; each definition is approved once per bot, and
// editing the server (for example its URL or allowed_tools) asks again.
permit(principal, action == Action::"UseServer", resource)
  when {
    resource.transport == "remote" &&
    resource.host == "api.githubcopilot.com" &&
    (resource.url == "https://api.githubcopilot.com/mcp/readonly" ||
     resource.url like "https://api.githubcopilot.com/mcp/x/*/readonly") &&
    context.approved
  };
