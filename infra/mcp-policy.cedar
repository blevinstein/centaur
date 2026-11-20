// Global operator ceiling for every registered repo. It permits nothing by itself: each repo's
// .centaur/mcp-policy.cedar still has to permit its servers, and this forbid cannot be lifted.
forbid(principal, action == Action::"UseServer", resource)
  unless {
    (resource.transport == "remote" && resource.url like "https://*") ||
    (resource.transport == "stdio" && resource.pinned)
  };
