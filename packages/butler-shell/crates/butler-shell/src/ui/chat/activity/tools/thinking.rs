//! `ThinkingDetails.tsx`: the reasoning summary a thinking row reveals.
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Role, Run, Tone, Typo, Weight, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Task, Window};

use super::copy::text;
use crate::ui::chat::TranscriptCtx;
use crate::ui::chat::activity::operation::{Ids, fetch_page};
use crate::ui::source::wire::ProgressRow;

#[derive(Default)]
struct Summary {
    stored: Option<String>,
    retained: Option<String>,
    failed: bool,
    started: bool,
    task: Option<Task<()>>,
}

/// `#`-headings and `**bold**` lines show as headings.
fn heading(line: &str) -> Option<&str> {
    let line = line.trim();
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) {
        let rest = &line[hashes..];
        let title = rest.trim_start();
        if title.len() < rest.len() && !title.is_empty() {
            return Some(title);
        }
    }
    line.strip_prefix("**")
        .and_then(|rest| rest.strip_suffix("**"))
        .filter(|inner| !inner.is_empty())
}

/// The text split at blank lines, each part trimmed; empty parts dropped.
fn paragraphs(body: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut lines: Vec<&str> = Vec::new();
    for line in body.lines().chain([""]) {
        if line.trim().is_empty() {
            let paragraph = lines.join("\n");
            if !paragraph.trim().is_empty() {
                found.push(paragraph.trim().to_owned());
            }
            lines.clear();
        } else {
            lines.push(line);
        }
    }
    found
}

fn paragraph(body: &str) -> Typo {
    let runs = body.split('\n').enumerate().map(|(index, line)| {
        let title = heading(line);
        let shown = title.unwrap_or(line);
        let shown = if index > 0 {
            format!("\n{shown}")
        } else {
            shown.to_owned()
        };
        match title {
            Some(_) => Run::new(shown)
                .tone(Tone::Secondary)
                .weight(Weight::Semibold),
            None => Run::new(shown).tone(Tone::Tertiary).weight(Weight::Regular),
        }
    });
    Typo::runs(Role::Caption, runs)
        .tone(Tone::Tertiary)
        .wrap(Wrap::Pre)
}

/// ThinkingDetails: the row's own text, else the stored output of its operation.
pub(super) fn thinking_details(
    row: &ProgressRow,
    ids: Option<Ids>,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = SharedString::from(format!("thinking-details:{}", row.id));
    let state = window.use_keyed_state(key, cx, |_, _| Summary::default());
    if let Some(own) = &row.thinking_body {
        state.update(cx, |summary, _| summary.retained = Some(own.clone()));
    } else if let Some(ids) = ids
        && !state.read(cx).started
    {
        let client = t.client.clone();
        state.update(cx, |summary, cx| {
            summary.started = true;
            summary.task = Some(cx.spawn(async move |this, cx| {
                let page = fetch_page(client, ids, 0).await;
                let _ = this.update(cx, |summary, cx| {
                    match page {
                        Some((content, _, _)) => summary.stored = Some(content),
                        None => summary.failed = true,
                    }
                    cx.notify();
                });
            }));
        });
    }
    let lang = Ds::get(cx).lang();
    let summary = state.read(cx);
    if summary.failed {
        return Typo::caption(text(lang, "d.outputLoadFailed")).into_any_element();
    }
    let shown = row
        .thinking_body
        .as_deref()
        .or(summary.stored.as_deref())
        .or(summary.retained.as_deref())
        .unwrap_or("");
    Stack::new()
        .gap(Space::Sm)
        .children(paragraphs(shown).iter().map(|body| paragraph(body)))
        .into_any_element()
}
