//! Root-reviewed dependency directions between the domains of one crate. A
//! facade is not permission to cycle. Directions between crates are declared
//! in each crate's Cargo.toml and enforced by Cargo.

#[expect(
    clippy::match_same_arms,
    reason = "arms are grouped per crate so the table reads as the crate layout"
)]
pub(super) fn dependencies(domain: &str) -> Option<&'static [&'static str]> {
    if let Some(edges) = platform_dependencies(domain) {
        return Some(edges);
    }
    Some(match domain {
        // butler-test-support: isolated source fakes consume only public platform APIs.
        "import_sources" => &[],
        // butler-core: leaf codecs and mirrors; JSON sanitizes public text.
        "configuration" | "js_date" | "json_lines" | "locale" | "public_text" | "segmentation"
        | "tool_protocol" | "tool_catalog" | "wall_clock" => &[],
        "json" => &["public_text"],
        // Typed hook envelopes preserve complete tool JSON.
        "hooks" => &["json"],
        // Plugin admin port carries inert values and secret-free failures.
        "plugins" => &[],
        // butler-canon: inert SQL definitions and pure chain invariants.
        "work_schema" | "work_queries" | "work_rank" | "work_types" => &[],
        "work_chain" => &["work_types"],
        "work_ids" => &[],
        "store" => &[
            "work_chain",
            "work_types",
            "work_ids",
            "work_rank",
            "work_queries",
        ],
        // butler-turn: BTCC owns the turn and reads the transcript and workspace.
        "btcc" => &["conversation", "workspace"],
        "conversation" | "workspace" => &[],
        // butler-models
        "models" | "mcp_client" => &[],
        // butler-runtime: capability adapters consume the skills facade; catalog
        // internals remain private. Operations and web access build on Context.
        "capabilities" => &["skills"],
        "context" | "skills" | "outputs" | "browser" | "previews" => &[],
        // Markdown documents are pure codecs; storage and turn evidence stay in adapters.
        "documents" => &[],
        // Imported sign-ins key on the browser policy's registrable site.
        "browser_import" => &["browser"],
        // Other agents' MCP servers and instructions: parsing only.
        "agent_import" => &[],
        "operations" => &["context"],
        "web_access" => &["browser", "context", "operations"],
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
        // Request-driven management reads stable cognition APIs and shares its writer lease.
        "management" => &["cognition", "coordination"],
        "profile" => &["coordination", "lenient"],
        "work_records" => &["lenient", "js_json"],
        "coordination" | "lenient" | "js_json" => &[],
        // butler-gateway and the host binary are single-domain crates.
        "gateway" | "host" | "structured_logging" => &[],
        // Outbound transport produces records through the structured logging facade.
        "http" => &["structured_logging"],
        // butler-shell-client: one connection domain; platform dependencies
        // cross the crate boundary declared in Cargo.toml.
        "shell_connection" => &[],
        // butler-e2e: dev-only harness around the built binary; one domain.
        "e2e" | "mail_connector" => &[],
        _ => return None,
    })
}

/// Native facades have their own leaf and adapter dependencies.
fn platform_dependencies(domain: &str) -> Option<&'static [&'static str]> {
    Some(match domain {
        // butler-platform: the only OS-specific code. Independent facades; each
        // keeps its per-OS implementations as private children. The private
        // Windows process table serves instance identity and liveness.
        // SQLite owns host VFS selection and file synchronization; DB state and schema stay in callers.
        "data_paths" | "cpu" | "memory" | "desktop" | "launcher" | "network" | "process_table"
        | "storage_size" | "stdio" | "time_zone" | "user_auth" | "user_dirs" | "diagnostics"
        | "account_dirs" | "process_priority" | "download_mark" | "plugin_files"
        | "shared_locks" => &[],
        "secure_fs" => &["data_paths", "user_dirs"],
        // SQLite synchronization, credentials, install pointers and post-run
        // quarantine consume the secure filesystem facade.
        "sqlite" | "fs_space" | "secrets" | "install_link" => &["secure_fs"],
        "command_sandbox" => &["secure_fs", "account_dirs", "data_paths"],
        "process_control" => &["process_table"],
        // The headless browser's DevTools pipe runs in a contained process tree.
        "browser_process" | "system_wake" => &["process_control"],
        // The installed App is found under the user's home; its windowless
        // browser host runs in a contained process tree.
        "app_browser" => &["process_control", "user_dirs"],
        // Hook processes compose shell selection and tree containment.
        "hook_process" | "preview_process" => &["command_sandbox", "process_control"],
        // Process naming owns verified executable aliases; instance queries
        // consume that identity without coupling general filesystem paths to it.
        "instance" => &["process_table", "process_names"],
        "process_names" => &["launcher", "secure_fs"],
        // Package activation waits for its parent and restores verified ZIP role links.
        "app_update" => &["process_control", "process_names", "secure_fs"],
        // User-entered paths resolve the user's home.
        "tool_paths" => &["user_dirs"],
        // Other browsers' profile folders are found in the account folders the OS
        // records (never a redirected HOME); user_dirs only scopes test fixtures.
        "browser_profiles" => &["account_dirs", "user_dirs"],
        // Other AI agents' setup files live in the same account folders.
        "agent_homes" => &["account_dirs"],
        // The `butler` command launcher is a runnable file under the user's
        // command directory; the Agent home's pointers are replaced atomically
        // with secure_fs; login-start definitions live under the user's home.
        "command_launcher" => &["launcher", "user_dirs"],
        // Manager definitions own private log destinations; E2E fixtures publish executables.
        "service_registration" => &["instance", "user_dirs", "secure_fs", "launcher"],
        // Native import reads source profiles, wipes secrets and opens consented exports.
        "browser_transfer" => &["browser_profiles", "secrets", "user_dirs", "desktop"],
        _ => return None,
    })
}
