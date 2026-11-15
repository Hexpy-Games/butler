//! snapshotPick orchestration: the existing isolated snapshot walker, frame copies and a closed CSP.
use super::{
    Item,
    geometry::{n, shift},
    probe::Frame,
    reader,
};
use crate::ui::browser::{
    engine::{Profile, TabId},
    model::BrowserState,
};
use gpui::AsyncApp;
use serde_json::{Value, json};
use std::fmt::Write as _;

const PAGE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../butler-app/client/electron/browser/snapshot-page.mjs"
));
const RESOURCES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../butler-app/client/electron/browser/snapshot-page-resources.mjs"
));
const SNAPSHOT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../butler-app/client/electron/browser/snapshot.mjs"
));
const CSP: &str = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const CLEAR: &str =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

async fn defaults(cx: &AsyncApp) -> anyhow::Result<Value> {
    let id = TabId(uuid::Uuid::new_v4().to_string().into());
    cx.update(|cx| {
        cx.global_mut::<BrowserState>().engine.open(
            &id,
            "about:blank",
            Profile::SignedOut,
            "snapshot-defaults",
        );
    });
    // Keep the existing blank-page defaults program and control list in one source of truth.
    let program = SNAPSHOT
        .split_once("const CONTROLS = ")
        .and_then(|(_, s)| s.split_once("let initial = null;"))
        .map(|(s, _)| format!("const CONTROLS = {s}"));
    let code = SNAPSHOT
        .split_once("return await win.webContents.executeJavaScript(`")
        .and_then(|(_, s)| s.split_once("`);"))
        .map(|(s, _)| s);
    let result = if let (Some(program), Some(code)) = (program, code) {
        async {
            let tree=reader::protocol(&id,"Page.getFrameTree",json!({}),cx).await?;
            let world=reader::protocol(&id,"Page.createIsolatedWorld",json!({"frameId":tree["frameTree"]["frame"]["id"],"worldName":"butler-pick"}),cx).await?;
            reader::protocol(&id,"Runtime.evaluate",json!({"contextId":world["executionContextId"],"expression":format!("{program}\neval(`{code}`)"),"returnByValue":true,"awaitPromise":true}),cx).await
        }.await
    } else {
        Err(anyhow::anyhow!("snapshot defaults source changed"))
    };
    cx.update(|cx| cx.global_mut::<BrowserState>().engine.close(&id));
    let result = result?;
    anyhow::ensure!(
        result.get("exceptionDetails").is_none(),
        "snapshot defaults failed"
    );
    Ok(result["result"]["value"].clone())
}
async fn run(
    page: &TabId,
    frame: &Frame,
    mut args: Value,
    defaults: &Value,
    serial: usize,
    cx: &AsyncApp,
) -> anyhow::Result<Value> {
    args["initial"] = defaults["initial"].clone();
    args["native"] = defaults["native"].clone();
    args["prefix"] = json!(format!("s{serial}"));
    let code = format!(
        "{}\n{}\nsnapshotPage({args},snapshotFonts,inlineSnapshotBlobs)",
        PAGE.replace("export ", ""),
        RESOURCES.replace("export ", "")
    );
    let result = reader::evaluate(page, &frame.path, code, cx).await?;
    anyhow::ensure!(
        !result.is_null() && result["tooLarge"] != true,
        "snapshot unavailable"
    );
    Ok(result)
}
pub(super) async fn capture(page: &TabId, item: &Item, cx: &AsyncApp) -> anyhow::Result<Value> {
    let generation = cx.update(|cx| {
        cx.global::<BrowserState>()
            .tab(page)
            .map(|t| t.pick.generation.get())
    });
    let defaults = defaults(cx).await?;
    let frame = &item.frame;
    let args = if item.area.is_some() {
        json!({"op":"area","rect":item.data["rect"]})
    } else {
        json!({"op":"element","identity":item.data["identity"]})
    };
    let root = run(page, frame, args, &defaults, 0, cx).await?;
    let mut html = root["html"].as_str().unwrap_or_default().to_owned();
    let mut parts = vec![(root.clone(), frame.clone())];
    let mut pending: std::collections::VecDeque<_> = root["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| (entry.clone(), frame.clone(), 1))
        .collect();
    while let Some((entry, base, depth)) = pending.pop_front() {
        let at = base.nested(&entry);
        let data = if depth <= 4 {
            run(
                page,
                &at,
                json!({"op":"frame","prune":entry["prune"]}),
                &defaults,
                parts.len(),
                cx,
            )
            .await
            .ok()
        } else {
            None
        };
        let marker = entry["marker"].as_str().unwrap_or_default();
        if let Some(data) = data {
            html = html.replace(marker, data["html"].as_str().unwrap_or_default());
            pending.extend(
                data["frames"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|e| (e.clone(), at.clone(), depth + 1)),
            );
            parts.push((data, at));
        } else {
            html = html.replace(
                marker,
                "<div style=\"display:block;width:100%;height:100%;background:#d9d9d9\"></div>",
            );
        }
    }
    let result = finish(page, &root, &parts, frame, html, cx).await?;
    anyhow::ensure!(
        generation
            == cx.update(|cx| cx
                .global::<BrowserState>()
                .tab(page)
                .map(|t| t.pick.generation.get())),
        "page changed during snapshot"
    );
    Ok(result)
}
async fn finish(
    page: &TabId,
    root: &Value,
    parts: &[(Value, Frame)],
    frame: &Frame,
    mut html: String,
    cx: &AsyncApp,
) -> anyhow::Result<Value> {
    let origins: Vec<_> = parts
        .iter()
        .filter_map(|(p, _)| p["base"].as_str())
        .filter_map(|s| url::Url::parse(s).ok())
        .map(|u| u.origin().ascii_serialization())
        .collect();
    let masks: Vec<_> = parts
        .iter()
        .flat_map(|(data, at)| {
            data["masks"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| shift(v, at.x, at.y))
        })
        .collect();
    let mut css = fonts(
        page,
        &parts.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(),
        &origins,
        cx,
    )
    .await
    .unwrap_or_default();
    for (data, at) in parts {
        css.push_str(data["css"].as_str().unwrap_or_default());
        for asset in data["assets"].as_array().into_iter().flatten() {
            let source = asset[0].as_str().unwrap_or_default();
            let token = asset[1].as_str().unwrap_or_default();
            let inline = super::resources::fetch(page, source, &origins, cx)
                .await
                .and_then(|a| {
                    anyhow::ensure!(a.mime.starts_with("image/"), "not an image");
                    Ok(a.data_url())
                })
                .unwrap_or_else(|_| CLEAR.to_owned());
            html = html.replace(token, &inline);
            css = css.replace(token, &inline);
        }
        for island in data["islands"].as_array().into_iter().flatten() {
            let rect = shift(&island["rect"], at.x, at.y);
            let inline = super::crop::island(page, &rect, at.clip.as_ref(), masks.clone(), cx)
                .await
                .unwrap_or_else(|_| CLEAR.to_owned());
            let token = island["token"].as_str().unwrap_or_default();
            html = html.replace(token, &inline);
            css = css.replace(token, &inline);
        }
    }
    let width = n(root, "width");
    let height = n(root, "height");
    let reset = ":where(body *:not(svg *):not(math *):not([data-native])),:where(body *:not(svg *):not(math *):not([data-native]))::before,:where(body *:not(svg *):not(math *):not([data-native]))::after,:where(body foreignObject *:not([data-native])),:where(body foreignObject *:not([data-native]))::before,:where(body foreignObject *:not([data-native]))::after";
    let backdrop = root["backdrop"].as_str().unwrap_or("transparent");
    let document = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\"><meta name=\"referrer\" content=\"no-referrer\"><base target=\"_blank\"><style>html{{background:{backdrop}}}html,body{{margin:0;padding:0}}body{{position:relative;width:{width}px;height:{height}px;overflow:hidden}}{reset}{{all:unset}}{}</style></head><body>{html}</body></html>",
        css.replace('<', "\\3c ")
    );
    anyhow::ensure!(
        document.encode_utf16().count() <= 5 * 1024 * 1024,
        "snapshot too large"
    );
    Ok(
        json!({"html":document,"width":width,"height":height,"x":n(root,"x")+frame.x,"y":n(root,"y")+frame.y}),
    )
}
async fn fonts(
    page: &TabId,
    parts: &[Value],
    origins: &[String],
    cx: &AsyncApp,
) -> anyhow::Result<String> {
    let helpers = SNAPSHOT
        .split_once("function parseFaces(")
        .and_then(|(_, s)| s.split_once("async function fontCss("))
        .map(|(s, _)| format!("function parseFaces({s}"))
        .ok_or_else(|| anyhow::anyhow!("snapshot font helpers changed"))?;
    let mut sheets = serde_json::Map::new();
    let urls: std::collections::BTreeSet<_> = parts
        .iter()
        .flat_map(|p| {
            p["fonts"]["sheets"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
        })
        .collect();
    for source in urls.into_iter().take(12) {
        if let Ok(asset) = super::resources::fetch(page, source, origins, cx).await
            && asset.bytes.len() <= 512 * 1024
        {
            sheets.insert(source.into(), json!(String::from_utf8_lossy(&asset.bytes)));
        }
    }
    let expression = format!(
        r"(()=>{{{helpers}
        const parts={parts},sheets={sheets},families=new Map(),chars=new Set(),faces=[];
        for(const p of parts){{for(const [family,uses] of p.families)families.set(family,new Set([...(families.get(family)??[]),...uses]));for(const c of p.chars)chars.add(c);faces.push(...p.fonts.faces)}}
        for(const [url,text] of Object.entries(sheets))faces.push(...parseFaces(text,url).filter(f=>families.has(f.family)));
        return neededFaces(faces,families,[...chars]).map(face=>({{face,url:faceSource(face)}})).filter(e=>e.url);
    }})()",
        parts = json!(parts),
        sheets = Value::Object(sheets)
    );
    let needed = reader::evaluate(page, &[], expression, cx).await?;
    let mut css = String::new();
    let mut total = 0;
    for entry in needed.as_array().into_iter().flatten() {
        let Some(source) = entry["url"].as_str() else {
            continue;
        };
        let Ok(asset) = super::resources::fetch(page, source, origins, cx).await else {
            continue;
        };
        if !asset.mime.starts_with("font/") {
            continue;
        }
        let data = asset.data_url();
        total += data.len();
        if total > 2_621_440 {
            continue;
        }
        css.push_str(&font_rule(&entry["face"], &data));
    }
    Ok(css)
}

fn font_rule(face: &Value, data: &str) -> String {
    let mut css = String::new();
    let family = face["family"]
        .as_str()
        .unwrap_or_default()
        .replace(['"', '\\'], "");
    let _ = write!(
        css,
        "@font-face{{font-family:\"{family}\";src:url(\"{data}\");font-display:block;"
    );
    for (key, property) in [
        ("weight", "font-weight"),
        ("style", "font-style"),
        ("stretch", "font-stretch"),
        ("range", "unicode-range"),
        ("features", "font-feature-settings"),
    ] {
        if let Some(value) = face[key].as_str() {
            let _ = write!(css, "{property}:{value};");
        }
    }
    css.push('}');
    css
}
