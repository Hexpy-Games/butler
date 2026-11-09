//! `documentExport.ts` and `DocumentExportMenu.tsx` `useDocumentExport` (Markdown): the file
//! name, the save dialog, and the body with its images inlined as data URLs.
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::ShellClient;
use gpui::App;
use regex::{Captures, Regex};
use serde_json::Value;

use super::api::Doc;
use super::copy::words;
use super::read_view::{Segment, parse, split};
use crate::ui::chat::answers::spec_markdown;
use crate::ui::source::agent::Jobs;

/// An image of the body whose destination is a document asset (`img_…`): alt, id, title.
const IMAGE: &str = r#"!\[((?:[^\]\\]|\\.)*)\]\((img_[^)\s"]*)(?:\s+"((?:[^"\\]|\\.)*)")?\)"#;

/// `documentFileName`
fn file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || u32::from(c) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name: String = cleaned
        .trim_end_matches(['.', ' '])
        .chars()
        .take(180)
        .collect();
    if name.is_empty() {
        "document".to_owned()
    } else {
        name
    }
}

/// The Markdown export of `doc`: the save dialog, then the file.
pub(super) fn markdown(doc: &Doc, cx: &mut App) {
    let directory = butler_platform::user_dirs::non_empty_home_dir()
        .map_or_else(PathBuf::new, |home| home.join("Downloads"));
    let name = format!("{}.md", file_name(&doc.title));
    let ask = cx.prompt_for_new_path(&directory, Some(&name));
    let body = doc.body.clone();
    let content = Jobs::run(
        cx,
        move |client| async move { portable(&client, &body).await },
    );
    let failed = words(Ds::get(cx).lang()).failed;
    cx.spawn(async move |cx| {
        let Ok(Ok(Some(path))) = ask.await else {
            return;
        };
        let written = match content.await.flatten() {
            Some(text) => {
                cx.background_executor()
                    .spawn(async move { std::fs::write(path, text).ok() })
                    .await
            }
            None => None,
        };
        if written.is_none() {
            cx.update(|cx| {
                toast::show(cx, Toast::error(failed));
            });
        }
    })
    .detach();
}

/// `exportDocumentMarkdown`: only image destinations are replaced; every other byte stays.
/// Each `blocks` fence becomes portable Markdown (`toMarkdown`) with its images inlined; a
/// fence that is not a spec stays as it is.
async fn portable(client: &ShellClient, body: &str) -> Option<String> {
    let image = Regex::new(IMAGE).ok()?;
    let parts = split(body);
    let mut ids = BTreeSet::new();
    for part in &parts {
        match part {
            Segment::Markdown(text) => ids.extend(
                image
                    .captures_iter(text)
                    .filter_map(|found| found.get(2).map(|id| id.as_str().to_owned())),
            ),
            Segment::Blocks { json, .. } => {
                if let Ok(spec) = serde_json::from_str::<Value>(json) {
                    asset_ids(&spec, &mut ids);
                }
            }
        }
    }
    let mut data = HashMap::new();
    for id in ids {
        let url = data_url(client, &id).await?;
        data.insert(id, url);
    }
    let mut out = String::with_capacity(body.len());
    for part in parts {
        match part {
            Segment::Markdown(text) => {
                out.push_str(&image.replace_all(text, |found: &Captures| inline(found, &data)));
            }
            Segment::Blocks { fence, json } => match parse(json) {
                Some(spec) => out.push_str(&spec_markdown(&spec, &|id| data.get(id).cloned())),
                None => out.push_str(fence),
            },
        }
    }
    Some(out)
}

/// The values of every `img` key of a spec (the `JSON.stringify` replacer of
/// `exportDocumentMarkdown`).
fn asset_ids(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                match inner {
                    Value::String(id) if key == "img" => {
                        ids.insert(id.clone());
                    }
                    _ => asset_ids(inner, ids),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|inner| asset_ids(inner, ids)),
        _ => {}
    }
}

/// `![alt](data:… "title")`
fn inline(found: &Captures, data: &HashMap<String, String>) -> String {
    let text = |at: usize| found.get(at).map_or("", |part| part.as_str());
    let url = data.get(text(2)).map_or("", String::as_str);
    let title = found
        .get(3)
        .map(|title| format!(" \"{}\"", title.as_str()))
        .unwrap_or_default();
    format!("![{}]({url}{title})", text(1))
}

/// `imageData`: the asset as a data URL.
async fn data_url(client: &ShellClient, id: &str) -> Option<String> {
    let file = client.download_message_asset(id, false).await.ok()?;
    let mime = file.content_type.unwrap_or_default();
    Some(format!("data:{mime};base64,{}", base64(&file.bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = chunk.iter().enumerate().fold(0_u32, |bits, (at, byte)| {
            bits | u32::from(*byte) << (16 - 8 * at)
        });
        for place in 0..4 {
            if place > chunk.len() {
                out.push('=');
                continue;
            }
            let index = usize::try_from((bits >> (18 - 6 * place)) & 63).unwrap_or_default();
            out.push(ALPHABET.get(index).copied().map_or('A', char::from));
        }
    }
    out
}
