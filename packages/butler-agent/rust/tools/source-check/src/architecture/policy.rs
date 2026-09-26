//! Root-reviewed domain dependency directions. A facade is not permission to cycle.

pub(super) fn dependencies(domain: &str) -> Option<&'static [&'static str]> {
    Some(match domain {
        "btcc" => &[
            "conversation",
            "workspace",
            "json",
            "locale",
            "public_text",
            "tool_protocol",
        ],
        "cognition" => &[
            "work_records",
            "conversation",
            "coordination",
            "profile",
            "models",
            "json",
            "locale",
            "public_text",
            "segmentation",
            "js_date",
        ],
        // Capability adapters consume the skills facade; catalog internals remain private.
        "capabilities" => &["workspace", "skills", "json", "public_text"],
        "configuration" | "js_date" | "locale" | "public_text" | "segmentation"
        | "tool_protocol" | "json_lines" => &[],
        "context" => &[
            "btcc",
            "configuration",
            "conversation",
            "models",
            "workspace",
            "json",
            "locale",
            "public_text",
            // Shared pure timestamp parsing for canonical conversation filters.
            "js_date",
        ],
        "conversation" => &["json", "locale", "public_text"],
        "coordination" => &["public_text"],
        "gateway" => &[
            "btcc",
            "conversation",
            "context",
            "cognition",
            "profile",
            "models",
            "workspace",
            "configuration",
            "operations",
            // Dashboard calendar labels reuse the pure civil-date conversion.
            "js_date",
            "json",
            "locale",
            "public_text",
            // App HTTP and session projections consume the native skills facade.
            "skills",
            // App MCP settings routes consume only the native MCP client facade.
            "mcp_client",
        ],
        "host" => &[
            "capabilities",
            "project_ledger",
            "work_records",
            "btcc",
            "context",
            "conversation",
            "coordination",
            "gateway",
            "models",
            "operations",
            "mcp_client",
            "profile",
            "workspace",
            "configuration",
            "cognition",
            "js_date",
            "json",
            "locale",
            "public_text",
            "segmentation",
            "web_access",
            // Host composes the skills lifecycle and consumes neutral bounded JSONL IO.
            "skills",
            "json_lines",
        ],
        "json" => &["public_text"],
        "models" => &["btcc", "configuration", "json", "locale", "public_text"],
        "mcp_client" => &["configuration", "json"],
        "operations" => &[
            "btcc",
            "context",
            "models",
            "js_date",
            "json",
            "public_text",
        ],
        "profile" => &[
            "context",
            "configuration",
            "coordination",
            "models",
            "js_date",
            "json",
            "locale",
            "public_text",
            "segmentation",
        ],
        // Skills owns catalog/archive semantics and uses only neutral JSONL IO and text parity.
        "skills" => &["json_lines", "public_text"],
        "workspace" => &["json", "public_text"],
        // Public retrieval owns provider configuration and delegates PDF text to Context.
        "web_access" => &[
            "configuration",
            "context",
            "json",
            // Search planning uses the shared pure timezone-aware date conversion.
            "js_date",
            "models",
            "operations",
            "public_text",
        ],
        "work_records" => &["json", "locale", "public_text"],
        // Ledger implements the declared BTCC Project Work port. SQLite ownership
        // remains behind that port; canonical files remain owned by Ledger.
        // Managed-record hashes also use the host's pure locale ordering.
        "project_ledger" => &["btcc", "js_date", "json", "locale", "public_text"],
        _ => return None,
    })
}
