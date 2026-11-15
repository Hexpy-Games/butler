use butler_cef_host::osr::{OsrConfig, chrome_version};
use butler_ds::ui::context::{Ds, Lang, Platform};
use gpui::App;
use std::path::PathBuf;

pub(super) fn config(cx: &App) -> anyhow::Result<OsrConfig> {
    let executable = std::env::current_exe()?;
    let contents = executable
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or_else(|| anyhow::anyhow!("missing executable directory"))?;
    let frameworks = std::env::var_os("BUTLER_CEF_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| contents.join("Frameworks"));
    let profile = crate::lifecycle::data_root(&std::env::args_os().collect::<Vec<_>>())
        .join("app/browser/profile");
    std::fs::create_dir_all(&profile)?;
    let ds = Ds::get(cx);
    Ok(OsrConfig {
        framework_dir: frameworks.join("Chromium Embedded Framework.framework"),
        helper_path: frameworks
            .join("butler-cef-host Helper.app/Contents/MacOS/butler-cef-host Helper"),
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
