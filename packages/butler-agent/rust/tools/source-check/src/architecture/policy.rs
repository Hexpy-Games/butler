//! Root-reviewed dependency directions between the domains of one crate. A
//! facade is not permission to cycle. Directions between crates are declared
//! in each crate's Cargo.toml and enforced by Cargo.

#[expect(
    clippy::match_same_arms,
    reason = "arms are grouped per crate so the table reads as the crate layout"
)]
pub(super) fn dependencies(domain: &str) -> Option<&'static [&'static str]> {
    Some(match domain {
        // butler-platform: the only OS-specific code. Independent facades; each
        // keeps its per-OS implementations as private children.
        "command_sandbox"
        | "instance"
        | "launcher"
        | "process_control"
        | "secure_fs"
        | "service_registration"
        | "user_dirs" => &[],
        // butler-core: leaf codecs and mirrors; JSON sanitizes public text.
        "configuration" | "js_date" | "json_lines" | "locale" | "public_text" | "segmentation"
        | "tool_protocol" => &[],
        "json" => &["public_text"],
        // butler-turn: BTCC owns the turn and reads the transcript and workspace.
        "btcc" => &["conversation", "workspace"],
        "conversation" | "workspace" => &[],
        // butler-models
        "models" | "mcp_client" => &[],
        // butler-runtime: capability adapters consume the skills facade; catalog
        // internals remain private. Operations and web access build on Context.
        "capabilities" => &["skills"],
        "context" | "skills" => &[],
        "operations" => &["context"],
        "web_access" => &["context", "operations"],
        // butler-ledger: SQLite ownership stays behind BTCC's Project Work port.
        "project_ledger" => &[],
        // butler-memory: Cognition coordinates writers, reads the profile and
        // records completed work. `lenient` (stored-JSON readers) and `js_json`
        // (JSON.stringify of typed records) are leaf helpers.
        "cognition" => &[
            "work_records",
            "coordination",
            "profile",
            "lenient",
            "js_json",
        ],
        "profile" => &["coordination", "lenient"],
        "work_records" => &["lenient", "js_json"],
        "coordination" | "lenient" | "js_json" => &[],
        // butler-gateway and the host binary are single-domain crates.
        "gateway" | "host" => &[],
        // butler-e2e: dev-only harness around the built binary; one domain.
        "e2e" => &[],
        _ => return None,
    })
}
