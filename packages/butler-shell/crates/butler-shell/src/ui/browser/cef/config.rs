use butler_cef_host::osr::{OsrConfig, chrome_version};
use butler_ds::ui::context::{Ds, Lang, Platform};
use gpui::App;
use std::path::PathBuf;

pub(super) fn config(cx: &App) -> anyhow::Result<OsrConfig> {
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
    })
}
/// The CEF runtime and helper. On Windows and Linux they sit in one directory, the output of
/// stage.py: `BUTLER_CEF_DIR` (development and tests), else the executable's own directory. On
/// macOS, `BUTLER_CEF_DIR` or the bundle's `Contents/Frameworks` holds the framework and the
/// helper app.
fn locations() -> anyhow::Result<(PathBuf, PathBuf)> {
    let executable = std::env::current_exe()?;
    let beside = executable
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing executable directory"))?;
    let platform = butler_platform::launcher::node_platform();
    let directory = std::env::var_os("BUTLER_CEF_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            if platform == "darwin" {
                beside.parent().map(|c| c.join("Frameworks"))
            } else {
                Some(beside.to_path_buf())
            }
        })
        .ok_or_else(|| anyhow::anyhow!("missing bundle Contents"))?;
    Ok(match platform {
        // CEF's resources, `locales` and the helper. libcef.dll is linked at load time, so
        // Windows loads it from beside the executable or `PATH`, not from here.
        "win32" => (directory.clone(), directory.join("butler_cef_host.exe")),
        // The bundle's `Contents/Frameworks`: the framework and the helper app.
        "darwin" => (
            directory.join("Chromium Embedded Framework.framework"),
            directory.join("butler-cef-host Helper.app/Contents/MacOS/butler-cef-host Helper"),
        ),
        // CEF's resources, `locales` and the helper. libcef.so is linked at load time, so Linux
        // finds it beside the executable through its `$ORIGIN` rpath, not from here.
        _ => (directory.clone(), directory.join("butler-cef-host")),
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
