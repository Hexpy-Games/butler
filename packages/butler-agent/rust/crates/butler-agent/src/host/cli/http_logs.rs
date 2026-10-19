//! Lazy writer uses the same validated folder as the command.
use std::{io, path::Path};
pub(super) fn prepare(data: &Path) {
    static PREPARED: std::sync::Once = std::sync::Once::new();
    PREPARED.call_once(|| prepare_once(data));
}
fn prepare_once(data: &Path) {
    let data = data.to_path_buf();
    let result = butler_log::http::initialize_with(move || {
        let data = data.clone();
        async move {
            tokio::task::spawn_blocking(move || {
                let config = butler_gateway::gateway::producer_log_config(
                    &data.join("app-server/butler-client.sqlite"),
                )?;
                butler_log::Logger::producer(&data, config)
            })
            .await
            .map_err(io::Error::other)?
        }
    });
    if result.is_err() {
        eprintln!("http_logging_unavailable: continuing without HTTP logs");
    }
}
