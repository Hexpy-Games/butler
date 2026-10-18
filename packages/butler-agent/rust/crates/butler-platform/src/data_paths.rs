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
/// Captured message asset images.
pub const ASSETS: &str = "app-server/assets";
/// Generated artifact files.
pub const ARTIFACTS: &str = "artifacts/generated";
/// Agent log directory; reset inspects direct files only.
pub const LOGS: &str = "logs";
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
/// Local administrator credential.
pub const LOCAL_ADMIN: &str = "app/runtime/auth/local-admin.json";
/// Local gateway authentication credential.
pub const LOCAL_AUTH: &str = "app/runtime/auth/local-agent-auth.json";
/// Project-folder token signing secret.
pub const FOLDER_SECRET: &str = "state/app-gateway/project-folder-token-secret";
/// Electron-owned stores: ui-crash-store.mjs, wallpaper-state-log.mjs and main.mjs.
pub const APP_LOGS: &str = "app/logs";
/// Electron composer draft files.
pub const COMPOSER_DRAFTS: &str = "app/composer-drafts";
/// Paths whose first component Butler creates itself.
pub const OWNED_PATHS: &[&str] = &[
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
