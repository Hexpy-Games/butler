//! Browser backend while no App is attached. Enabled by default, including
//! when the App launched the Agent. The installed App's Electron runs on
//! demand without a window; Chrome for Testing serves App-less installs.
//! `BUTLER_BROWSER_HEADLESS=on|off` overrides `headlessBrowser` in the App
//! gateway config for Chrome fallback. The installed App engine is always
//! available. Neither backend starts until a browser call needs it.
//! `BUTLER_BROWSER_APP`: `off`, or an Electron executable to run instead
//! of the installed App's (with `BUTLER_BROWSER_APP_DIR`, the App directory a
//! development Electron loads).
use butler_gateway::gateway::HeadlessBrowserConfig;
use butler_platform::app_browser::AppElectron;
use butler_runtime::browser::{AppHostSource, InstallSource};
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
        _ => configured.unwrap_or(true),
    };
    Some(HeadlessBrowserConfig {
        enabled,
        root: data_root.join("state/browser/headless"),
        app_host: app_host_source(),
        app_host_root: data_root.join("state/browser/app-host"),
        install: InstallSource {
            cache_root: env_value("BUTLER_BROWSER_CACHE_DIR")
                .map_or_else(|| data_root.join("cache/browser"), Into::into),
            base_url: env_value("BUTLER_BROWSER_DOWNLOAD_BASE"),
        },
    })
}

fn app_host_source() -> AppHostSource {
    match env_value("BUTLER_BROWSER_APP") {
        None => AppHostSource::Installed,
        Some(value) if value == "off" => AppHostSource::Off,
        Some(executable) => AppHostSource::Electron(AppElectron {
            executable: executable.into(),
            app_dir: env_value("BUTLER_BROWSER_APP_DIR").map(Into::into),
        }),
    }
}
