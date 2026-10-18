//! Structured agent logging: one writer, bounded indexed readers and shared redaction.
mod bodies;
mod config;
mod encoded;
mod export;
mod files;
mod index;
mod layer;
pub(crate) use layer::current_ids;
mod patterns;
mod query;
mod record;
mod redaction;
mod retention;
mod segment;
mod storage;
mod writer;

pub use config::{Config, ConfigView, Preset};
pub use query::{Page, Query};
pub use record::Record;
pub use redaction::{
    Secret, redact_headers, redact_json, redact_log_line, redact_url, register_endpoint,
    register_ephemeral_secret, register_secret, register_secret_for,
};
pub use retention::{StorageView, StoreUsage};
use std::{io, sync::OnceLock};
pub use writer::Logger;

static GLOBAL: OnceLock<Logger> = OnceLock::new();
pub fn global() -> Option<&'static Logger> {
    GLOBAL.get()
}
pub fn install(logger: Logger) -> io::Result<()> {
    use tracing_subscriber::prelude::*;
    let subscriber = tracing_subscriber::registry().with(layer::LogLayer(logger.clone()));
    tracing::subscriber::set_global_default(subscriber).map_err(io::Error::other)?;
    butler_core::diagnostics::set_redactor(redact_log_line);
    GLOBAL
        .set(logger)
        .map_err(|_| io::Error::other("logger already installed"))
}
/// Stable producer API for wrappers which already have structured attributes.
pub fn emit(row: Record) {
    if let Some(log) = global() {
        let _ = log.record(row);
    }
}
