// `context.args` is an empty record: the arguments are open-ended, so a policy reads them only
// behind `has`, which the validator accepts but treats as always false (see docs/mcp.md).
export const MCP_POLICY_SCHEMA = `
entity Bot;
entity McpServer = {
  transport: String,
  host: String,
  url: String,
  command: String,
  args: Set<String>,
  pinned: Bool,
};
entity McpTool = {
  server: String,
  name: String,
};
action UseServer appliesTo {
  principal: Bot,
  resource: McpServer,
  context: { approved: Bool },
};
action CallTool appliesTo {
  principal: Bot,
  resource: McpTool,
  context: { args: {} },
};
`;
