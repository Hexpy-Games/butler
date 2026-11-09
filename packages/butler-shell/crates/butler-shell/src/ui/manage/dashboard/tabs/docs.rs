//! What the panels share: the dashboard documents they hand to `select`, the pin write of
//! `preferences` (`app/projectDashboardState.ts`, `ProjectMaterialsPanel.tsx` `togglePin`) and
//! the loaded counts a rebuilt panel starts from (`rememberDashboardLoadedCount`).
use std::collections::HashMap;

use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{App, ClickEvent, Context, Global, SharedString, Window};
use serde_json::{Value, json};

use super::copy::{Words, words};
use crate::ui::manage::dashboard::DashboardCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{
    DashboardArtifact, DashboardSourceRef, ProjectDashboardDocument, ProjectDashboardDocumentKind,
    ProjectDashboardDocumentType, ProjectDashboardPreferences,
};

/// `projectDocumentType`: the document type, else its kind, as the wire spells it.
pub(super) fn type_name(document: &ProjectDashboardDocument) -> &'static str {
    use ProjectDashboardDocumentKind as Kind;
    use ProjectDashboardDocumentType as Type;
    match &document.document_type {
        Some(Type::Plan) => "plan",
        Some(Type::Task) => "task",
        Some(Type::Spec) => "spec",
        Some(Type::Report) => "report",
        Some(Type::Artifact) => "artifact",
        Some(Type::Reference) => "reference",
        Some(Type::Message) => "message",
        Some(Type::Roadmap) => "roadmap",
        Some(Type::Work) => "work",
        Some(Type::Unknown) => "unknown",
        None => match document.kind {
            Kind::Plan => "plan",
            Kind::Spec => "spec",
            Kind::Report => "report",
            Kind::Unknown => "unknown",
        },
    }
}

fn type_of(kind: &str) -> ProjectDashboardDocumentType {
    use ProjectDashboardDocumentType as Type;
    match kind {
        "plan" => Type::Plan,
        "task" => Type::Task,
        "spec" => Type::Spec,
        "report" => Type::Report,
        "artifact" => Type::Artifact,
        "reference" => Type::Reference,
        "message" => Type::Message,
        "roadmap" => Type::Roadmap,
        "work" => Type::Work,
        _ => Type::Unknown,
    }
}

/// The document `onSelect` receives for a record: its body is read when it opens.
fn document(
    project: &str,
    (id, revision): (&str, &str),
    (kind, document_type): (ProjectDashboardDocumentKind, ProjectDashboardDocumentType),
    title: &str,
    label: &str,
    updated_at: &str,
) -> ProjectDashboardDocument {
    ProjectDashboardDocument {
        artifact: None,
        unavailable: None,
        revision: Some(revision.to_owned()),
        project_id: Some(project.to_owned()),
        truncated: None,
        nextCursor: None,
        id: id.to_owned(),
        kind,
        document_type: Some(document_type),
        title: title.to_owned(),
        category: None,
        status: None,
        safe_path_label: label.to_owned(),
        markdown: String::new(),
        updated_at: updated_at.to_owned(),
    }
}

/// The history and statistics rows: `kind` is `spec`, `report` or else `plan`.
pub(super) fn from_source(
    project: &str,
    source: &DashboardSourceRef,
    title: &str,
    at: &str,
) -> ProjectDashboardDocument {
    let kind = match source.kind.as_str() {
        "spec" => ProjectDashboardDocumentKind::Spec,
        "report" => ProjectDashboardDocumentKind::Report,
        _ => ProjectDashboardDocumentKind::Plan,
    };
    document(
        project,
        (&source.id, &source.revision),
        (kind, type_of(&source.kind)),
        title,
        &source.id,
        at,
    )
}

/// A published result as a document (`ProjectResultsPanel` row click).
pub(super) fn from_artifact(project: &str, item: &DashboardArtifact) -> ProjectDashboardDocument {
    document(
        project,
        (&item.artifact.id, &item.revision),
        (
            ProjectDashboardDocumentKind::Report,
            ProjectDashboardDocumentType::Artifact,
        ),
        &item.artifact.title,
        &item.artifact.title,
        &item.artifact.created_at,
    )
}

/// The pinned refs after pinning (or unpinning) `kind:id`.
pub(super) fn toggled_pins(
    preferences: &ProjectDashboardPreferences,
    kind: &str,
    id: &str,
    revision: &str,
) -> Vec<Value> {
    let same = |pin: &DashboardSourceRef| pin.id == id && pin.kind == kind;
    let pinned = preferences.pinned_source_refs.iter().any(same);
    let mut pins: Vec<Value> = preferences
        .pinned_source_refs
        .iter()
        .filter(|pin| !same(pin))
        .map(|pin| json!({ "kind": pin.kind, "id": pin.id, "revision": pin.revision }))
        .collect();
    if !pinned {
        pins.push(json!({ "kind": kind, "id": id, "revision": revision }));
    }
    pins
}

/// `PATCH /projects/{id}/dashboard/preferences`, then `onUpdated`; a refusal toasts
/// `feedback.dashboardRetry` (`notifyError`).
pub(super) fn save_pins<P: 'static>(
    ctx: &DashboardCtx,
    pins: &[Value],
    window: &Window,
    cx: &mut Context<P>,
) {
    let Some(preferences) = ctx.preferences.clone() else {
        return;
    };
    let (project, handle, updated) = (
        ctx.project.to_string(),
        window.window_handle(),
        ctx.updated.clone(),
    );
    let body = json!({ "expectedRevision": preferences.revision, "pinnedSourceRefs": pins });
    fetch(
        cx,
        move |client| async move {
            client
                .update_project_dashboard_preferences(&project, &body)
                .await
        },
        move |_: &mut P, result: Result<Value, Error>, cx| match result {
            Ok(_) => cx.defer(move |cx| {
                let _ = handle.update(cx, |_, window, cx| updated(window, cx));
            }),
            Err(_) => {
                let message = words(Ds::get(cx).lang()).dashboard_retry;
                toast::show(cx, Toast::error(message));
            }
        },
    );
}

/// The error notice every panel shows, with its Retry.
pub(super) fn retry_notice(
    id: &'static str,
    message: &'static str,
    words: &Words,
    on_retry: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Notice {
    Notice::new(NoticeTone::Error, message).action(
        Button::new(id)
            .variant(Variant::Outline)
            .text(words.retry)
            .on_click(on_retry),
    )
}

/// The loaded counts per project and list (`useProjectDashboardState.loadedCounts`).
#[derive(Default)]
struct LoadedCounts(HashMap<(SharedString, &'static str), usize>);

impl Global for LoadedCounts {}

/// How many rows the list had when it was last on screen.
pub(super) fn loaded_count(cx: &App, project: &SharedString, list: &'static str) -> Option<usize> {
    cx.try_global::<LoadedCounts>()
        .and_then(|counts| counts.0.get(&(project.clone(), list)).copied())
}

/// `rememberDashboardLoadedCount`
pub(super) fn remember_count(cx: &mut App, project: &SharedString, list: &'static str, n: usize) {
    cx.default_global::<LoadedCounts>()
        .0
        .insert((project.clone(), list), n);
}
