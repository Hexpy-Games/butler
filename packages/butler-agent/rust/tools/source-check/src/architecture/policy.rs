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
        // keeps its per-OS implementations as private children. The private
        // Windows process table serves instance identity and liveness.
        // SQLite owns only the host VFS choice; DB state and schema stay in callers.
        "command_sandbox" | "cpu" | "desktop" | "launcher" | "network" | "process_table"
        | "secure_fs" | "sqlite" | "stdio" | "time_zone" | "user_dirs" => &[],
        "process_control" => &["process_table"],
        // Process naming owns verified executable aliases; instance queries
        // consume that identity without coupling general filesystem paths to it.
        "instance" => &["process_table", "process_names"],
        "process_names" => &["launcher", "secure_fs"],
        // Package activation waits for its parent and restores verified ZIP role links.
        "app_update" => &["process_control", "process_names", "secure_fs"],
        // The credential store's owner-only fallback file is a secure_fs file.
        "secrets" => &["secure_fs"],
        // The `butler` command launcher is a runnable file under the user's
        // command directory; the Agent home's pointers are replaced atomically
        // with secure_fs; login-start definitions live under the user's home.
        "command_launcher" => &["launcher", "user_dirs"],
        "install_link" => &["secure_fs"],
        // Manager definitions own private log destinations; E2E fixtures publish executables.
        "service_registration" => &["instance", "user_dirs", "secure_fs", "launcher"],
        // Timestamp formatting and the operational diagnostic macro are a leaf.
        "diagnostics" => &[],
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
