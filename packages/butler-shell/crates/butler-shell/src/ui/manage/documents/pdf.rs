//! Print the Electron document renderer's HTML in a hidden, signed-out CEF embed.
use super::api::Doc;
use super::{copy::words, export::file_name};
use butler_ds::ui::{
    context::Ds,
    toast::{self, Toast},
};
use gpui::App;
use std::path::PathBuf;

pub(super) fn export(doc: &Doc, cx: &mut App) {
    let directory = butler_platform::user_dirs::non_empty_home_dir()
        .map_or_else(PathBuf::new, |home| home.join("Downloads"));
    let name = format!("{}.pdf", file_name(&doc.title));
    let ask = cx.prompt_for_new_path(&directory, Some(&name));
    let doc = doc.clone();
    cx.spawn(async move |cx| {
        if let Ok(Ok(Some(path))) = ask.await {
            cx.update(|cx| save(doc, path, cx));
        }
    })
    .detach();
}

/// The native prompt and a scripted harness path both enter the same export pipeline.
pub(crate) fn save(doc: Doc, path: PathBuf, cx: &mut App) {
    let copy = words(Ds::get(cx).lang());
    #[cfg(feature = "cef")]
    {
        let dark = Ds::get(cx).dark();
        let lang = if Ds::get(cx).lang() == butler_ds::ui::context::Lang::Ko {
            "ko"
        } else {
            "en"
        };
        let content = crate::ui::source::agent::Jobs::run(cx, move |client| async move {
            let mut assets = Vec::new();
            for asset in &doc.assets {
                let url = super::export::data_url(&client, &asset.id).await?;
                assets.push(serde_json::json!({"id":asset.id, "url":url, "signed_url":url, "image_width":asset.image_width, "image_height":asset.image_height}));
            }
            Some(serde_json::json!({"id":"", "title":doc.title, "body":doc.body, "rev":doc.rev, "assets":assets}).to_string())
        });
        cx.spawn(async move |cx| {
            let ok = match content.await.flatten() {
                Some(doc) => print(doc, dark, lang, path, cx).await.is_some(),
                None => false,
            };
            cx.update(|cx| {
                toast::show(
                    cx,
                    if ok {
                        Toast::success(copy.saved)
                    } else {
                        Toast::error(copy.failed)
                    },
                )
            });
        })
        .detach();
    }
    #[cfg(not(feature = "cef"))]
    {
        let _ = (doc, path);
        toast::show(cx, Toast::error(copy.failed));
    }
}

#[cfg(feature = "cef")]
async fn print(
    doc: String,
    dark: bool,
    lang: &str,
    path: PathBuf,
    cx: &mut gpui::AsyncApp,
) -> Option<()> {
    use crate::ui::browser::printing::HiddenPage;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let css = include_str!(concat!(env!("OUT_DIR"), "/document-export/document.css"));
    let js = include_str!(concat!(env!("OUT_DIR"), "/document-export/document.js"));
    let js = js.replace("</script", "<\\/script");
    let theme = if dark { "theme-dark" } else { "theme-light" };
    let input = STANDARD.encode(doc);
    let nonce = uuid::Uuid::new_v4();
    let render_policy = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:"
    );
    let html = format!(
        "<!doctype html><html lang=\"{lang}\" class=\"{theme}\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{render_policy}\"><style>{css}</style></head><body class=\"{theme}\"><div id=\"document-input\" hidden>{input}</div><script nonce=\"{nonce}\">{js}</script></body></html>"
    );
    let renderer = HiddenPage::load_html(html, cx).await?;
    let html = renderer.html(cx).await?;
    drop(renderer);
    // Match document-export.mjs: no network, scripts, navigation or popups in the print page.
    let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">";
    let html = html.replacen("<head>", &format!("<head>{policy}"), 1);
    let printer = HiddenPage::load_html(html, cx).await?;
    printer.print(&path, cx).await
}
