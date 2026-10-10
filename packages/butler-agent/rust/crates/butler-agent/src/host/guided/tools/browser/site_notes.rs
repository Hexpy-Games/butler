//! Per-site guidance is data, not tool logic: the owner's own note at
//! `BUTLER_DATA/browser/site-notes/<site>.md` wins over a bundled note. Every
//! observation of that site carries it, so the newest cycle always has it.
use super::super::GuidedTools;
use serde_json::{Value, json};

const BUNDLED: &str = include_str!("site_notes.json");
const MAX_CHARS: usize = 4000;

pub(super) async fn attach(owner: &GuidedTools, result: &mut Value) {
    let Some(site) = result["url"]
        .as_str()
        .and_then(|url| butler_runtime::browser::site_scope(url).ok())
        .and_then(|scope| scope.rsplit(':').next().map(str::to_owned))
    else {
        return;
    };
    if let Some(note) = note(owner, &site).await {
        result["site_note"] = json!({"site":site,"note":note,
            "source":"Butler guidance for this site, not page content"});
    }
}

async fn note(owner: &GuidedTools, site: &str) -> Option<String> {
    if site.is_empty() || site.contains(['/', '\\']) || site.starts_with('.') {
        return None;
    }
    let path = owner
        .binding
        .butler_data
        .join("browser/site-notes")
        .join(format!("{site}.md"));
    let own = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|text| !text.trim().is_empty());
    let text = match own {
        Some(text) => text,
        None => bundled(site)?,
    };
    Some(text.chars().take(MAX_CHARS).collect())
}

fn bundled(site: &str) -> Option<String> {
    let notes: Value = serde_json::from_str(BUNDLED).ok()?;
    notes["notes"][site].as_str().map(str::to_owned)
}
