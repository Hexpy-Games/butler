//! The open project document: `selectDocument`, the dialog's load-more and reference actions
//! (`ProjectDashboardView.tsx`), `app/projectDocumentSource.ts` and `useProjectArtifactAttachment`.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{App, Context};
use serde::Deserialize;
use serde_json::json;

use super::copy::words;
use super::state::DashboardPage;
use crate::ui::composer::state::{ComposerAttachment, ComposerState};
use crate::ui::composer::{Composer, fill_composer_with_template};
use crate::ui::manage::ManageCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{
    MessageFileRef, ProjectDashboardDocument, ProjectDashboardDocumentKind,
    ProjectDashboardDocumentType,
};

/// `selectedDocument` and `selectionEpoch`.
#[derive(Default)]
pub(super) struct Selection {
    pub(super) document: Option<ProjectDashboardDocument>,
    epoch: u64,
}

/// `projectDocumentType`
pub(super) fn document_type(document: &ProjectDashboardDocument) -> ProjectDashboardDocumentType {
    use ProjectDashboardDocumentType as Type;
    document
        .document_type
        .clone()
        .unwrap_or(match document.kind {
            ProjectDashboardDocumentKind::Plan => Type::Plan,
            ProjectDashboardDocumentKind::Spec => Type::Spec,
            ProjectDashboardDocumentKind::Report => Type::Report,
            ProjectDashboardDocumentKind::Unknown => Type::Unknown,
        })
}

/// The `kind` query of `/dashboard/source`.
fn type_name(document: &ProjectDashboardDocument) -> &'static str {
    use ProjectDashboardDocumentType as Type;
    match document_type(document) {
        Type::Plan => "plan",
        Type::Task => "task",
        Type::Spec => "spec",
        Type::Artifact => "artifact",
        Type::Reference => "reference",
        Type::Message => "message",
        Type::Roadmap => "roadmap",
        Type::Work => "work",
        Type::Report | Type::Unknown => "report",
    }
}

/// `{ file: MessageFileRef }` of `POST /dashboard/attachment`.
#[derive(Deserialize)]
struct Attached {
    file: MessageFileRef,
}

impl DashboardPage {
    /// `selectDocument`: read the document's first page; a later selection or a close wins.
    pub(super) fn select_document(
        &mut self,
        document: ProjectDashboardDocument,
        cx: &mut Context<Self>,
    ) {
        self.selection.epoch += 1;
        let epoch = self.selection.epoch;
        let (Some(project), Some(revision)) =
            (document.project_id.clone(), document.revision.clone())
        else {
            if document.markdown.is_empty() {
                Self::documents_failed(cx);
            } else {
                self.selection.document = Some(document);
                cx.notify();
            }
            return;
        };
        let (kind, id) = (type_name(&document), document.id.clone());
        fetch(
            cx,
            move |client| async move {
                client
                    .get_project_dashboard_source(&project, kind, &id, &revision, None)
                    .await
            },
            move |this: &mut Self, result: Result<ProjectDashboardDocument, Error>, cx| {
                if this.selection.epoch != epoch {
                    return;
                }
                match result {
                    Ok(page) => this.selection.document = Some(page),
                    Err(_) => Self::documents_failed(cx),
                }
            },
        );
    }

    /// `notifyError(error, projectDocumentsFailed)`
    fn documents_failed(cx: &mut App) {
        let copy = words(Ds::get(cx).lang());
        toast::show(cx, Toast::error(copy.documents_failed));
    }

    /// The dialog's close.
    pub(super) fn close_document(&mut self, cx: &mut Context<Self>) {
        self.selection.epoch += 1;
        self.selection.document = None;
        self.expanded = None;
        cx.notify();
    }

    /// `onLoadMore`: the next page joins the open document, if it is still the open one.
    pub(super) fn load_more(&mut self, cx: &mut Context<Self>) {
        let Some(current) = self.selection.document.clone() else {
            return;
        };
        let (Some(cursor), Some(project), Some(revision)) = (
            current.nextCursor.clone(),
            current.project_id.clone(),
            current.revision.clone(),
        ) else {
            return;
        };
        let epoch = self.selection.epoch;
        let (kind, id) = (type_name(&current), current.id.clone());
        fetch(
            cx,
            move |client| async move {
                client
                    .get_project_dashboard_source(&project, kind, &id, &revision, Some(&cursor))
                    .await
            },
            move |this: &mut Self, result: Result<ProjectDashboardDocument, Error>, cx| {
                if this.selection.epoch != epoch {
                    return;
                }
                match result {
                    Ok(next) => {
                        let markdown = format!("{}{}", current.markdown, next.markdown);
                        this.selection.document =
                            Some(ProjectDashboardDocument { markdown, ..next });
                    }
                    Err(_) => Self::documents_failed(cx),
                }
            },
        );
    }

    /// `onStartChatWithDocument`: the document joins the dashboard's composer.
    pub(super) fn reference_document(
        &mut self,
        document: &ProjectDashboardDocument,
        cx: &mut Context<Self>,
    ) {
        self.selection.document = None;
        cx.notify();
        let copy = words(Ds::get(cx).lang());
        if let (Some(_), Some(revision)) = (&document.artifact, &document.revision) {
            self.attach_artifact(&document.id, revision, cx);
            return;
        }
        fill_composer_with_template(copy.source_question, cx);
        add_to_composer(&self.ctx, document, cx);
    }

    /// `useProjectArtifactAttachment`: copy the artifact into the project and attach the copy,
    /// unless the composer moved off this dashboard's draft meanwhile.
    fn attach_artifact(&mut self, id: &str, revision: &str, cx: &mut Context<Self>) {
        let (project, draft) = (self.project.to_string(), self.project.clone());
        let body = json!({ "id": id, "revision": revision });
        fetch(
            cx,
            move |client| async move {
                client
                    .create_project_dashboard_attachment(&project, &body)
                    .await
            },
            move |_: &mut Self, result: Result<Attached, Error>, cx| {
                let Ok(Attached { file }) = result else {
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.dashboard_retry));
                    return;
                };
                let key = format!("dashboard:{draft}");
                let copy = words(Ds::get(cx).lang());
                let added = ComposerState::update(cx, |composer| {
                    if composer.draft_session_id != key {
                        return false;
                    }
                    composer.attachments.push(ComposerAttachment {
                        id: file.file_id.clone(),
                        kind: file.kind.clone(),
                        file,
                    });
                    true
                });
                if added {
                    fill_composer_with_template(copy.source_question, cx);
                }
            },
        );
    }
}

/// `composer.addProjectDocument` on the window's composer, which the dashboard shows.
pub(super) fn add_to_composer(ctx: &ManageCtx, document: &ProjectDashboardDocument, cx: &mut App) {
    let Some(composer) = ctx
        .composer(cx)
        .and_then(|view| view.downcast::<Composer>().ok())
    else {
        return;
    };
    composer.update(cx, |composer, cx| composer.add_document(document, cx));
}

/// A source the dashboard names by id, as a document to open (`documentFor`, the overview card).
pub(super) fn source_document(
    id: &str,
    project: &str,
    revision: Option<&str>,
    title: &str,
    kind: ProjectDashboardDocumentKind,
    document_type: ProjectDashboardDocumentType,
    updated_at: &str,
) -> ProjectDashboardDocument {
    ProjectDashboardDocument {
        artifact: None,
        unavailable: None,
        revision: revision.map(str::to_owned),
        project_id: Some(project.to_owned()),
        truncated: None,
        nextCursor: None,
        id: id.to_owned(),
        kind,
        document_type: Some(document_type),
        title: title.to_owned(),
        category: None,
        status: None,
        safe_path_label: id.to_owned(),
        markdown: String::new(),
        updated_at: updated_at.to_owned(),
    }
}

/// The document type a briefing source kind names (`document_type: item.kind`).
pub(super) fn type_of_kind(kind: &str) -> ProjectDashboardDocumentType {
    use ProjectDashboardDocumentType as Type;
    match kind {
        "plan" => Type::Plan,
        "task" => Type::Task,
        "spec" => Type::Spec,
        "report" => Type::Report,
        "message" => Type::Message,
        "work" => Type::Work,
        _ => Type::Unknown,
    }
}

/// `item.kind === "spec" ? "spec" : item.kind === "report" ? "report" : "plan"`
pub(super) fn document_kind(kind: &str) -> ProjectDashboardDocumentKind {
    match kind {
        "spec" => ProjectDashboardDocumentKind::Spec,
        "report" => ProjectDashboardDocumentKind::Report,
        _ => ProjectDashboardDocumentKind::Plan,
    }
}
