//! Immutable product gates selected by packaging, defaulting to enabled.

/// Whether this build includes the Browser product surface.
pub const BROWSER: bool = match option_env!("BUTLER_FEATURE_BROWSER") {
    Some(value) => !matches!(value.as_bytes(), [b'f', b'a', b'l', b's', b'e']),
    None => true,
};

/// Whether a catalog tool belongs to the enabled product surface.
pub fn tool_enabled(name: &str) -> bool {
    BROWSER || !matches!(name, "output_publish" | "output_check")
}
