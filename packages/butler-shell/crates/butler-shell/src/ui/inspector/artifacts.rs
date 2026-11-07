//! `ArtifactsPanel` and `AutomationTargetsPanel`.
use std::collections::HashMap;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::artifact_list::{ArtifactAction, ArtifactItem, ArtifactList};
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::inspector_panel::InspectorInset;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo, Weight};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::InspectorCtx;
use crate::ui::chat::files::support::save_file;
use crate::ui::i18n::inspector_artifacts::InspectorArtifacts;
use crate::ui::i18n::media::Media;
use crate::ui::source::wire::{MessageRecord, SessionArtifactSummary};
use crate::ui::viewer::{self, FileViewerEntry};

/// One result per workspace path and content; keep its latest delivery (`sessionArtifacts`).
fn session_artifacts(
    summary: &[SessionArtifactSummary],
    messages: &[MessageRecord],
) -> Vec<SessionArtifactSummary> {
    let mut latest: HashMap<String, &SessionArtifactSummary> = HashMap::new();
    let from_messages = messages.iter().flat_map(|m| m.artifacts.iter().flatten());
    for artifact in summary.iter().chain(from_messages) {
        if artifact.deliverable != Some(true) {
            continue;
        }
        let key = match (&artifact.source_label, &artifact.sha256) {
            (Some(label), Some(sha)) if !label.is_empty() && !sha.is_empty() => {
                format!("{label}\u{0}{sha}")
            }
            _ => artifact.id.clone(),
        };
        if latest
            .get(&key)
            .is_none_or(|previous| artifact.created_at >= previous.created_at)
        {
            latest.insert(key, artifact);
        }
    }
    let mut all: Vec<SessionArtifactSummary> = latest.into_values().cloned().collect();
    all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    all
}

/// `formatArtifactSize`.
fn format_artifact_size(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024. * 1024.))
    }
}

/// `openArtifact`: opens the file in the conversation's file viewer.
fn open_artifact(artifact: &SessionArtifactSummary, session: &str, cx: &mut App) {
    let entry = if artifact.kind == "doc" {
        FileViewerEntry::Document {
            id: artifact.id.clone(),
            title: artifact.title.clone(),
        }
    } else {
        FileViewerEntry::Artifact {
            id: artifact.id.clone(),
            artifact: Box::new(artifact.clone()),
        }
    };
    viewer::open(cx, session, entry);
}

/// One tile (`DocumentTile` with `artifactCardActions`).
fn artifact_item(artifact: &SessionArtifactSummary, session: &str, cx: &App) -> ArtifactItem {
    let mut item = ArtifactItem::new(artifact.title.clone()).icon(Icon::FileText);
    if let Some(bytes) = artifact.size_bytes {
        item = item.description(format_artifact_size(bytes));
    }
    if artifact.kind != "web"
        && let Some(file_id) = artifact.file_id.clone()
    {
        let name = artifact
            .safe_path_label
            .clone()
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| artifact.title.clone());
        item = item.action(
            ArtifactAction::new(Media::get(cx).save)
                .icon(Icon::Save)
                .on_click(move |_, _, cx| save_file(file_id.clone(), name.clone(), cx)),
        );
    }
    let (opened, session) = (artifact.clone(), session.to_owned());
    item.on_open(move |_, _, cx| open_artifact(&opened, &session, cx))
}

/// `SessionSectionHeader`: the title with its count at the end.
fn section_header(title: &'static str, count: usize) -> AnyElement {
    Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(Typo::caption(title).tone(Tone::Secondary).weight(Weight::Medium))
        .child(Typo::caption(count.to_string()).tone(Tone::Secondary).tabular())
        .into_any_element()
}

/// The session's artifacts.
pub(crate) fn artifacts_panel(
    ctx: &InspectorCtx<'_>,
    compact: bool,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = InspectorArtifacts::get(cx);
    let all = session_artifacts(&ctx.view.artifacts, &ctx.view.messages);
    let body: AnyElement = if all.is_empty() {
        EmptyLine::new(copy.artifacts_empty)
            .icon(icon(Icon::Circle, IconSize::Md, Ds::get(cx)))
            .into_any_element()
    } else {
        let mut list = ArtifactList::new(SharedString::from("inspector-artifacts"));
        for artifact in &all {
            list = list.item(artifact_item(artifact, &ctx.view.session_id, cx));
        }
        list.into_any_element()
    };
    InspectorInset::new()
        .child(
            Stack::new()
                .gap(Space::Md)
                .children((!compact).then(|| Typo::panel_section_title(copy.artifacts_title)))
                .children(compact.then(|| section_header(copy.results_title, all.len())))
                .child(body),
        )
        .into_any_element()
}

/// The automation targets; `None` when the session has none.
pub(crate) fn automation_targets_panel(
    ctx: &InspectorCtx<'_>,
    compact: bool,
    _window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if ctx.view.automations.is_empty() {
        return None;
    }
    let lang = Ds::get(cx).lang();
    let rows = ctx.view.automations.iter().map(|automation| {
        ListRow::new(automation.title.clone())
            .icon(icon(Icon::Clock3, IconSize::Md, Ds::get(cx)))
            .meta(InspectorArtifacts::frequency(lang, automation))
    });
    Some(
        InspectorInset::new()
            .child(
                Stack::new()
                    .gap(Space::Sm)
                    .children((!compact).then(|| {
                        Typo::panel_section_title(InspectorArtifacts::get(cx).automations_title)
                    }))
                    .children(compact.then(|| {
                        section_header(
                            InspectorArtifacts::get(cx).automations_title,
                            ctx.view.automations.len(),
                        )
                    }))
                    .child(Stack::new().gap(Space::Xs).children(rows)),
            )
            .into_any_element(),
    )
}
