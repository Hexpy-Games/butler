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
];
/// Adjacent lock files created by settings/document writers.
pub const LOCKED_FILES: &[&str] = &[CONFIG, EOL];
/// Top-level directory paths (the remaining single-component paths are files).
pub const OWNED_DIRECTORIES: &[&str] = &[COGNITION, TRANSCRIPTS, WALLPAPERS, OUTPUTS, DOWNLOADS];
