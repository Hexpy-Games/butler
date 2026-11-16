use butler_cef_host::osr::{OsrConfig, chrome_version};
use butler_ds::ui::context::{Ds, Lang, Platform};
use gpui::App;
use std::path::PathBuf;

/// `adapter`: the consumer's GPU adapter LUID; CEF and the frame copies follow it (Windows).
pub(super) fn config(adapter: Option<u64>, cx: &App) -> anyhow::Result<OsrConfig> {
    let (framework_dir, helper_path) = locations()?;
    let profile = crate::lifecycle::data_root(&std::env::args_os().collect::<Vec<_>>())
        .join("app/browser/profile");
    std::fs::create_dir_all(&profile)?;
    let ds = Ds::get(cx);
    Ok(OsrConfig {
        framework_dir,
        helper_path,
        profile_dir: profile,
        locale: match ds.lang() {
            Lang::Ko => "ko",
            Lang::En => "en-US",
        }
        .into(),
        user_agent: web_user_agent(
            &chrome_version(),
            crate::lifecycle::APP_VERSION,
            ds.platform(),
        ),
        adapter_luid: adapter,
    })
}
/// The CEF runtime and helper: `BUTLER_CEF_DIR` (development and tests), else beside the
/// executable as stage.py lays it out.
fn locations() -> anyhow::Result<(PathBuf, PathBuf)> {
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing executable directory"))?;
    let windows = super::windows();
    let directory = std::env::var_os("BUTLER_CEF_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            if windows {
                Some(directory.to_path_buf())
            } else {
                directory.parent().map(|c| c.join("Frameworks"))
            }
        })
        .ok_or_else(|| anyhow::anyhow!("missing bundle Contents"))?;
    Ok(if windows {
        // CEF's resources, `locales` and the helper. libcef.dll is linked at load time, so
        // Windows loads it from beside the executable or `PATH`, not from here.
        (directory.clone(), directory.join("butler_cef_host.exe"))
    } else {
        // The bundle's `Contents/Frameworks`: the framework and the helper app.
        (
            directory.join("Chromium Embedded Framework.framework"),
            directory.join("butler-cef-host Helper.app/Contents/MacOS/butler-cef-host Helper"),
        )
    })
}
fn web_user_agent(chrome: &str, app: &str, platform: Platform) -> String {
    let token = match platform {
        Platform::Mac => "Macintosh; Intel Mac OS X 10_15_7",
        Platform::Windows => "Windows NT 10.0; Win64; x64",
        Platform::Linux => "X11; Linux x86_64",
    };
    let chrome = chrome.split('.').next().unwrap_or(chrome);
    let app = app.split('.').next().unwrap_or(app);
    format!(
        "Mozilla/5.0 ({token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chrome}.0.0.0 Safari/537.36 Butler/{app}"
    )
}
