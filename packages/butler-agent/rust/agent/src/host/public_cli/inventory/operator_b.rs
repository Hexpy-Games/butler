use super::Entry;

pub(super) const ROUTES: &[Entry] = &[
    route!(
        "conversation.historical-recovery",
        "butler conversation historical-recovery [--transcript-file PATH] [--app-db PATH] [--write]",
        "Plan or import historical Conversation rows from explicit source files.",
        "operator"
    ),
    route!(
        "personalization.show",
        "butler personalization show",
        "Read canonical personalization.",
        "operator"
    ),
    route!(
        "personalization.get",
        "butler personalization get KEY",
        "Read a personalization field.",
        "operator"
    ),
    route!(
        "personalization.set",
        "butler personalization set KEY VALUE",
        "Update personalization.",
        "operator"
    ),
    route!(
        "personalization.migration.prompt",
        "butler personalization migration prompt",
        "Build a profile import prompt.",
        "operator"
    ),
    route!(
        "personalization.migration.import",
        "butler personalization migration import",
        "Import reviewed profile facts.",
        "operator"
    ),
    route!(
        "search.status",
        "butler search status",
        "Show web search provider status.",
        "operator"
    ),
    route!(
        "search.test",
        "butler search test QUERY",
        "Test web search on demand.",
        "operator"
    ),
    route!(
        "web.read",
        "butler web read URL",
        "Read a public web page on demand.",
        "operator"
    ),
    route!(
        "update",
        "butler update [--check|--dry-run|--apply --yes]",
        "Check or stage a verified native update.",
        "operator"
    ),
    route!(
        "context.status",
        "butler context status",
        "Estimate context from installed and canonical facts.",
        "operator"
    ),
    route!(
        "context.compact",
        "butler context compact --session ID --yes",
        "Compact canonical Conversation context.",
        "operator"
    ),
    route!(
        "context.prune",
        "butler context prune",
        "Prune native tool output and old metrics.",
        "operator"
    ),
    route!(
        "maintenance.context",
        "butler maintenance context",
        "Run manual Context retention.",
        "operator"
    ),
    route!(
        "transport.status",
        "butler transport status",
        "Inspect the mock transport adapter.",
        "operator"
    ),
    route!(
        "transport.test",
        "butler transport test [--transport mock]",
        "Test the mock transport adapter.",
        "operator"
    ),
    route!(
        "mcp.serve",
        "butler mcp serve",
        "Serve native MCP over stdio.",
        "operator",
        false
    ),
    route!(
        "mcp.list",
        "butler mcp list",
        "List external MCP servers.",
        "operator"
    ),
    route!(
        "mcp.add",
        "butler mcp add",
        "Register an external MCP server.",
        "operator"
    ),
    route!(
        "mcp.enable",
        "butler mcp enable ID",
        "Enable an external MCP server.",
        "operator"
    ),
    route!(
        "mcp.disable",
        "butler mcp disable ID",
        "Disable an external MCP server.",
        "operator"
    ),
    route!(
        "mcp.delete",
        "butler mcp delete ID --yes",
        "Delete an external MCP server.",
        "operator"
    ),
    route!(
        "mcp.test",
        "butler mcp test ID",
        "Probe an external MCP server.",
        "operator"
    ),
    route!(
        "work.dashboard",
        "butler work dashboard",
        "Read preserved Work and Task records.",
        "operator"
    ),
    route!(
        "work.list",
        "butler work list",
        "List preserved Work and Task records.",
        "operator"
    ),
    route!(
        "work.show",
        "butler work show ID",
        "Inspect a preserved Work or Task record.",
        "operator"
    ),
    route!(
        "work.resume",
        "butler work resume ID",
        "Validate recoverable legacy intent without execution.",
        "operator"
    ),
    route!(
        "work.latest",
        "butler work latest",
        "Read the latest Work record.",
        "operator"
    ),
    route!(
        "skills.list",
        "butler skills list",
        "List installed Skills.",
        "operator"
    ),
    route!(
        "skills.inspect",
        "butler skills inspect NAME",
        "Inspect an installed Skill.",
        "operator"
    ),
    route!(
        "skills.import",
        "butler skills import PATH",
        "Import a Skill.",
        "operator"
    ),
    route!(
        "skills.validate",
        "butler skills validate PATH",
        "Validate a Skill.",
        "operator"
    ),
];
