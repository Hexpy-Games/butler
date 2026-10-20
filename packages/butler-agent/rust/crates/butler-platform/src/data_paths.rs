//! DATA-relative paths shared by storage writers and ownership migration.
/// Butler settings file.
pub const CONFIG: &str = "butler.config.json";
/// App storage database.
pub const APP_DB: &str = "app-server/butler-client.sqlite";
/// Runtime database.
pub const BTCC_DB: &str = "agent-runtime/btcc.sqlite";
/// App gateway settings.
pub const GATEWAY_CONFIG: &str = "gateways/app.json";
/// Provider credential identifiers.
pub const PROVIDER_CREDENTIALS: &str = "auth/model-provider-credentials.json";
/// Cognition stores.
pub const COGNITION: &str = "cognition";
/// First-chat onboarding state.
pub const ONBOARDING: &str = "personalization/onboarding.json";
/// Active persona document.
pub const PERSONA: &str = "personas/active.md";
/// EOL instructions document.
pub const EOL: &str = "eol.md";
/// Default session pointer.
pub const SESSION_POINTER: &str = "config/session-id.txt";
/// Durable inbound event queue.
pub const INBOUND: &str = "runtime/inbound-events";
/// Conversation transcripts.
pub const TRANSCRIPTS: &str = "transcripts";
/// User wallpaper modules.
pub const WALLPAPERS: &str = "wallpapers";
/// Context metrics stream.
pub const CONTEXT_METRICS: &str = "metrics/context-monitor.jsonl";
/// Cached sandbox capability probe.
pub const SANDBOX_PROBE: &str = "sandbox-mountns-probe.json";
/// Generated outputs.
pub const OUTPUTS: &str = "outputs";
/// Browser downloads.
pub const DOWNLOADS: &str = "downloads";
/// Store directories created by Rust storage writers.
pub const MESSAGE_FILES: &str = "app-server/message-files";
/// Durable deliverable copies awaiting App attachment commit.
pub const MESSAGE_HANDOFFS: &str = "app-server/message-files/.handoffs";
/// Captured message asset images.
pub const ASSETS: &str = "app-server/assets";
/// Generated artifact files.
pub const ARTIFACTS: &str = "artifacts/generated";
/// Agent log directory; reset retains launcher files and removes owned stores.
pub const LOGS: &str = "logs";
/// Native structured-log store name beneath LOGS.
pub const NATIVE_LOG_STORE: &str = "agent";
/// App structured-log store name beneath LOGS.
pub const APP_LOG_STORE: &str = "app";
/// Owned structured-log subdirectories; other log directories are preserved.
pub const OWNED_LOG_STORES: &[&str] = &[NATIVE_LOG_STORE, APP_LOG_STORE];
/// Installed skill packages.
pub const SKILLS: &str = "skills";
/// User hook settings.
pub const HOOKS: &str = "hooks.json";
/// Private environment settings.
pub const ENVIRONMENT: &str = ".env";
/// App favicon cache.
pub const FAVICONS: &str = "cache/favicons";
/// Butler-created session Git worktrees.
pub const WORKTREES: &str = "worktrees";
/// Durable work-stream records.
pub const WORK_STREAMS: &str = "work-streams";
/// Butler temporary files and web-access spool.
pub const TEMPORARY: &str = "tmp";
/// Windows sandbox scratch drives.
pub const SANDBOX_DRIVES: &str = "sandbox/drives";
/// Windows sandbox policy cache.
pub const SANDBOX_POLICIES: &str = "sandbox/policies";
/// Linux sandbox generated artifact roots.
pub const SANDBOX_GENERATED: &str = "sandbox-generated";
/// Sandbox credential quarantine.
pub const SANDBOX_QUARANTINE: &str = "sandbox-quarantine";
/// Scheduler checkpoints.
pub const SCHEDULER: &str = "state/scheduler";
/// Headless browser profiles.
pub const HEADLESS_BROWSER: &str = "state/browser/headless";
/// App-host browser profiles.
pub const APP_HOST_BROWSER: &str = "state/browser/app-host";
// Literal folders, so each credential path below is built from its folder.
macro_rules! local_auth_dir {
    () => {
        "app/runtime/auth"
    };
}
macro_rules! folder_secret_dir {
    () => {
        "state/app-gateway"
    };
}
/// Folder of the gateway and local admin credentials, their locks and
/// rotation temporaries; it holds nothing else.
pub const LOCAL_AUTH_DIR: &str = local_auth_dir!();
/// Local administrator credential.
pub const LOCAL_ADMIN: &str = concat!(local_auth_dir!(), "/local-admin.json");
/// Local gateway authentication credential.
pub const LOCAL_AUTH: &str = concat!(local_auth_dir!(), "/local-agent-auth.json");
/// Folder of the project-folder token secret, its lock and rotation
/// temporaries; it holds nothing else.
pub const FOLDER_SECRET_DIR: &str = folder_secret_dir!();
/// Project-folder token signing secret.
pub const FOLDER_SECRET: &str = concat!(folder_secret_dir!(), "/project-folder-token-secret");
/// App gateway credential folders that sandboxed commands must never read.
pub const GATEWAY_CREDENTIAL_DIRS: &[&str] = &[LOCAL_AUTH_DIR, FOLDER_SECRET_DIR];
/// Electron-owned stores: ui-crash-store.mjs, wallpaper-state-log.mjs and main.mjs.
pub const APP_LOGS: &str = "app/logs";
/// Electron composer draft files.
pub const COMPOSER_DRAFTS: &str = "app/composer-drafts";
/// Legacy schedules reimported into App storage.
pub const LEGACY_SCHEDULES: &str = "automations";
/// Legacy memory namespace migration source.
pub const LEGACY_MEMORY: &str = "memory";
/// Private context compaction evidence.
pub const COMPACTIONS: &str = "context/compactions";
/// Legacy task records and their memory source.
pub const TASKS: &str = "tasks";
/// Incremental transcript projection spool.
pub const TRANSCRIPT_PROJECTION_SPOOL: &str = "transcript-projection-spool";
/// Exported private diagnostic bundles.
pub const LOG_EXPORTS: &str = "log-exports";
/// Guided command cache state.
pub const TOOL_CACHE: &str = "cache/tools";
/// Project-write command cache state.
pub const PROJECT_WRITE_CACHE: &str = "cache/project-write";
/// Project-write temporary files.
pub const PROJECT_WRITE_TMP: &str = "tmp/project-write";
/// Private validated reader copies, inaccessible to commands.
pub const READER_STAGING: &str = "tmp/reader-staging";
/// Paths whose first component Butler creates itself.
pub const OWNED_PATHS: &[&str] = &[
    LEGACY_SCHEDULES,
    LEGACY_MEMORY,
    COMPACTIONS,
    TASKS,
    TRANSCRIPT_PROJECTION_SPOOL,
    LOG_EXPORTS,
    TOOL_CACHE,
    PROJECT_WRITE_CACHE,
    CONFIG,
    APP_DB,
    BTCC_DB,
    GATEWAY_CONFIG,
    PROVIDER_CREDENTIALS,
    COGNITION,
    ONBOARDING,
    PERSONA,
    EOL,
    SESSION_POINTER,
    INBOUND,
    TRANSCRIPTS,
    WALLPAPERS,
    CONTEXT_METRICS,
    SANDBOX_PROBE,
    OUTPUTS,
    DOWNLOADS,
    MESSAGE_FILES,
    ASSETS,
    ARTIFACTS,
    SKILLS,
    HOOKS,
    ENVIRONMENT,
    FAVICONS,
    WORKTREES,
    WORK_STREAMS,
    TEMPORARY,
    SANDBOX_DRIVES,
    SANDBOX_POLICIES,
    SANDBOX_GENERATED,
    SANDBOX_QUARANTINE,
    SCHEDULER,
    HEADLESS_BROWSER,
    APP_HOST_BROWSER,
    LOCAL_ADMIN,
    LOCAL_AUTH,
    FOLDER_SECRET,
    APP_LOGS,
    COMPOSER_DRAFTS,
];
/// Adjacent lock files created by settings/document writers.
pub const LOCKED_FILES: &[&str] = &[CONFIG, EOL];
/// Directory-valued store paths; other complete paths name regular files.
pub const OWNED_DIRECTORIES: &[&str] = &[
    LEGACY_SCHEDULES,
    LEGACY_MEMORY,
    COMPACTIONS,
    TASKS,
    TRANSCRIPT_PROJECTION_SPOOL,
    LOG_EXPORTS,
    TOOL_CACHE,
    PROJECT_WRITE_CACHE,
    COGNITION,
    TRANSCRIPTS,
    WALLPAPERS,
    OUTPUTS,
    DOWNLOADS,
    MESSAGE_FILES,
    ASSETS,
    ARTIFACTS,
    SKILLS,
    FAVICONS,
    WORKTREES,
    WORK_STREAMS,
    TEMPORARY,
    SANDBOX_DRIVES,
    SANDBOX_POLICIES,
    SANDBOX_GENERATED,
    SANDBOX_QUARANTINE,
    SCHEDULER,
    HEADLESS_BROWSER,
    APP_HOST_BROWSER,
    APP_LOGS,
    COMPOSER_DRAFTS,
];

/// Data-relative credential stores, including rotation temporaries and quarantine.
pub const CREDENTIAL_ROOTS: &[&str] = &[
    "auth",
    "secrets",
    SANDBOX_QUARANTINE,
    LOCAL_AUTH_DIR,
    FOLDER_SECRET_DIR,
    PROVIDER_CREDENTIALS,
    ENVIRONMENT,
];
