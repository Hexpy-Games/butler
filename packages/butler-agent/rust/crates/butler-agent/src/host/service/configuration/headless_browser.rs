//! Butler's own headless browser (P4): the browser tools' backend while no
//! App is attached. On by default where no App runs this Agent (CLI and
//! server installs); with the App it is opt-in (`headlessBrowser: true` in
//! the App gateway settings), since the App's browser serves those calls.
use butler_gateway::gateway::HeadlessBrowserConfig;
use butler_runtime::browser::InstallSource;
use std::{env, path::Path};

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

pub(super) fn headless_browser(
    data_root: &Path,
    configured: Option<bool>,
) -> Option<HeadlessBrowserConfig> {
    let enabled = match env_value("BUTLER_BROWSER_HEADLESS").as_deref() {
        Some("on") => true,
        Some("off") => false,
        _ => configured
            .unwrap_or_else(|| env_value("BUTLER_APP_BUNDLED_SUPERVISOR").as_deref() != Some("1")),
    };
    Some(HeadlessBrowserConfig {
        enabled,
        root: data_root.join("state/browser/headless"),
        install: InstallSource {
            cache_root: env_value("BUTLER_BROWSER_CACHE_DIR")
                .map_or_else(|| data_root.join("cache/browser"), Into::into),
            base_url: env_value("BUTLER_BROWSER_DOWNLOAD_BASE"),
        },
    })
}
