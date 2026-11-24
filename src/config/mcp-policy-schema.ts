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
action UseServer appliesTo {
  principal: Bot,
  resource: McpServer,
  context: { approved: Bool },
};
`;
