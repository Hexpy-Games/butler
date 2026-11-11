//! `ArtifactsPanel` and `AutomationTargetsPanel`.
use std::collections::HashMap;
use std::sync::Arc;

use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::inspector_panel::InspectorInset;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::button::{self, Button, Size as ButtonSize, Variant};
use butler_ds::ui::card::Card;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo, Weight, Wrap};
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::InspectorCtx;
use crate::ui::chat::files::support::save_file;
use crate::ui::i18n::Locale;
use crate::ui::i18n::inspector_artifacts::InspectorArtifacts;
use crate::ui::i18n::media::Media;
use crate::ui::source::wire::{MessageRecord, SessionArtifactSummary};
use crate::ui::viewer::{self, FileViewerEntry};
use crate::ui::widgets::anchor;

/// One result per workspace path and content; keep its latest delivery (`sessionArtifacts`).
/// The order is React's: a key keeps the place it was first seen at (a `Map`), then a stable
/// sort by delivery time, so results delivered together keep that order on every render.
fn session_artifacts(
    summary: &[SessionArtifactSummary],
    messages: &[Arc<MessageRecord>],
) -> Vec<SessionArtifactSummary> {
    let mut slots: HashMap<String, usize> = HashMap::new();
    let mut latest: Vec<&SessionArtifactSummary> = Vec::new();
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
        match slots.get(&key) {
            Some(&slot) if artifact.created_at >= latest[slot].created_at => {
                latest[slot] = artifact;
            }
            Some(_) => {}
            None => {
                slots.insert(key, latest.len());
                latest.push(artifact);
            }
        }
    }
    let mut all: Vec<SessionArtifactSummary> = latest.into_iter().cloned().collect();
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

/// `artifactDescription` and `artifactMeta`: the size, then the age, as the caption line.
fn artifact_caption(artifact: &SessionArtifactSummary, cx: &App) -> String {
    let strings = match Ds::get(cx).lang() {
        Lang::Ko => Locale::Ko.strings(),
        Lang::En => Locale::En.strings(),
    };
    let age = chrono::DateTime::parse_from_rfc3339(&artifact.created_at)
        .map(|at| strings.relative_age((chrono::Utc::now() - at.to_utc()).num_seconds().max(0)))
        .unwrap_or_default();
    [artifact.size_bytes.map(format_artifact_size), Some(age)]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// One tile (`DocumentTile` with `artifactCardActions`, `clickTarget="tile"`): the icon on the
/// title line, the title over its caption, the save action at the top right.
fn artifact_tile(
    artifact: &SessionArtifactSummary,
    index: usize,
    session: &str,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let id = SharedString::from(format!("inspector-artifact-{index}"));
    let mut copy = Stack::new().gap(Space::Xs).child(
        Typo::body(artifact.title.clone())
            .weight(Weight::Medium)
            .line_clamp(2)
            .wrap(Wrap::Anywhere),
    );
    let caption = artifact_caption(artifact, cx);
    if !caption.is_empty() {
        copy = copy.child(
            div()
                .min_w_0()
                .child(Typo::caption(caption).tone(Tone::Secondary).truncate()),
        );
    }
    let body = div()
        .flex()
        .items_start()
        .flex_1()
        .min_w_0()
        .gap(ds.len(Length::SpaceSm))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .h(ds.len(Length::TypoBodyLineHeight))
                .text_color(ds.color(Color::TextTertiary))
                .child(icon(Icon::FileText, IconSize::Md, ds)),
        )
        .child(div().flex_1().min_w_0().child(copy));
    let save = (artifact.kind != "web")
        .then(|| artifact.file_id.clone())
        .flatten()
        .map(|file_id| {
            let name = artifact
                .safe_path_label
                .clone()
                .filter(|label| !label.is_empty())
                .unwrap_or_else(|| artifact.title.clone());
            let button = Button::new((ElementId::from(id.clone()), "save"))
                .variant(Variant::Outline)
                .size(ButtonSize::Xs)
                .icon_start(icon(Icon::Save, IconSize::Sm, ds))
                .text(Media::get(cx).save)
                .on_click(move |_, _, cx| save_file(file_id.clone(), &name, cx));
            // The action does not open the tile.
            div()
                .flex_none()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(button::container(ButtonSize::Xs).child(button))
        });
    let (opened, session) = (artifact.clone(), session.to_owned());
    let card = Card::new(id)
        .interactive()
        .on_click(move |_, _, cx| open_artifact(&opened, &session, cx))
        .child(
            div()
                .flex()
                .items_start()
                .gap(ds.len(Length::SpaceSm))
                .min_w_0()
                .child(body)
                .children(save),
        );
    anchor(div().w_full(), &format!("artifact-tile-{index}"))
        .child(card)
        .into_any_element()
}

/// `SessionSectionHeader`: the title with its count at the end.
fn section_header(title: &'static str, count: usize) -> AnyElement {
    Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(
            Typo::caption(title)
                .tone(Tone::Secondary)
                .weight(Weight::Medium),
        )
        .child(
            Typo::caption(count.to_string())
                .tone(Tone::Secondary)
                .tabular(),
        )
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
    let body: AnyElement =
        if all.is_empty() {
            EmptyLine::new(copy.artifacts_empty)
                .icon(icon(Icon::Circle, IconSize::Md, Ds::get(cx)))
                .into_any_element()
        } else {
            Stack::new()
                .gap(Space::Xs)
                .children(all.iter().enumerate().map(|(index, artifact)| {
                    artifact_tile(artifact, index, &ctx.view.session_id, cx)
                }))
                .into_any_element()
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
