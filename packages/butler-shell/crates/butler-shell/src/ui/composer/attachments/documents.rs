//! `ComposerProjectDocumentGroups`, `projectDocuments` (`projectDocumentFileName`,
//! `projectDocumentType`, the picker filters), `projectDocumentSource` and the project-document
//! half of `useFileAttachments` (`addProjectDocument`).

use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::filtered_select_popover::{Filter, Group, Item};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::Toast;
use butler_shell_client::ShellClient;
use gpui::{App, SharedString, Window};
use serde::Deserialize;

use super::{ATTACHMENT_MAX_BYTES, Extra, Uploaded, upload_bytes};
use crate::ui::composer::state::ComposerAttachment;
use crate::ui::i18n::composer::attachments::copy;
use crate::ui::source::wire::{
    MessageContentPart, ProjectDashboardDocument, ProjectDashboardDocumentKind,
    ProjectDashboardDocumentType, ProjectSourceReference, ProjectSourceReferenceKind,
};

/// A picker group id (`ProjectDocumentGroup`); the filter ids are these and "all".
const GROUPS: [&str; 6] = ["spec", "roadmap", "work", "plan", "report", "task"];

/// The picked-document callback of the picker.
pub(crate) type PickDocument = Rc<dyn Fn(&ProjectDashboardDocument, &mut Window, &mut App)>;

/// `projectDocumentGroups` titles.
fn group_title(id: &str, cx: &App) -> &'static str {
    let copy = copy(Ds::get(cx).lang());
    match id {
        "spec" => copy.spec,
        "roadmap" => copy.roadmap,
        "work" => copy.work,
        "plan" => copy.plan,
        "report" => copy.report,
        _ => copy.task,
    }
}

/// `projectDocumentPickerFilters`: the "all" chip and one chip per group.
pub(crate) fn picker_filters(
    cx: &App,
    on_select: impl Fn(&str, &mut Window, &mut App) + Clone + 'static,
) -> Vec<Filter> {
    let all = copy(Ds::get(cx).lang()).all;
    std::iter::once(("all", all))
        .chain(GROUPS.map(|id| (id, group_title(id, cx))))
        .map(|(id, label)| {
            let on_select = on_select.clone();
            Filter::new(id, label, move |window, cx| on_select(id, window, cx))
        })
        .collect()
}

/// `projectDocumentType`: the document's type, or its kind.
fn document_type(document: &ProjectDashboardDocument) -> ProjectDashboardDocumentType {
    document
        .document_type
        .clone()
        .unwrap_or(match document.kind {
            ProjectDashboardDocumentKind::Plan => ProjectDashboardDocumentType::Plan,
            ProjectDashboardDocumentKind::Spec => ProjectDashboardDocumentType::Spec,
            ProjectDashboardDocumentKind::Report => ProjectDashboardDocumentType::Report,
            ProjectDashboardDocumentKind::Unknown => ProjectDashboardDocumentType::Unknown,
        })
}

/// `normalizedProjectDocumentType`: messages, references and artifacts count as reports.
fn normalized_type(document: &ProjectDashboardDocument) -> Option<&'static str> {
    use ProjectDashboardDocumentType as Type;
    match document_type(document) {
        Type::Spec => Some("spec"),
        Type::Roadmap => Some("roadmap"),
        Type::Work => Some("work"),
        Type::Plan => Some("plan"),
        Type::Task => Some("task"),
        Type::Report | Type::Message | Type::Reference | Type::Artifact => Some("report"),
        Type::Unknown => None,
    }
}

/// `filterProjectDocuments`: no artifacts; the filter's type; titles containing the search.
fn visible<'a>(
    documents: &'a [ProjectDashboardDocument],
    filter: &str,
    search: &str,
) -> Vec<&'a ProjectDashboardDocument> {
    let query = search.trim().to_lowercase();
    documents
        .iter()
        .filter(|document| {
            if document.document_type == Some(ProjectDashboardDocumentType::Artifact) {
                return false;
            }
            if filter != "all" && normalized_type(document) != Some(filter) {
                return false;
            }
            query.is_empty() || document.title.to_lowercase().contains(&query)
        })
        .collect()
}

/// `documentIcon`.
fn document_icon(document: &ProjectDashboardDocument, ds: &Ds) -> gpui::AnyElement {
    let glyph = match normalized_type(document) {
        Some("roadmap") => Icon::BookOpenText,
        Some("task") => Icon::ListChecks,
        _ => Icon::FileText,
    };
    gpui::IntoElement::into_any_element(icon(glyph, IconSize::Md, ds))
}

/// `projectDocumentPickerGroups`: one group per type, each with its visible documents.
pub(crate) fn picker_groups(
    documents: &[ProjectDashboardDocument],
    filter: &str,
    search: &str,
    on_pick: &PickDocument,
    cx: &App,
) -> Vec<Group> {
    let shown = visible(documents, filter, search);
    let ds = Ds::get(cx);
    GROUPS
        .iter()
        .map(|group| {
            let items = shown
                .iter()
                .filter(|document| normalized_type(document) == Some(*group))
                .map(|document| {
                    let pick = on_pick.clone();
                    let chosen = (*document).clone();
                    Item::new(
                        document.id.clone(),
                        SharedString::from(document.title.clone()),
                    )
                    .tooltip(document.title.clone())
                    .icon(document_icon(document, ds))
                    .on_select(move |window, cx| pick(&chosen, window, cx))
                })
                .collect();
            Group::new(*group, group_title(group, cx), items)
        })
        .collect()
}

/// `projectDocumentFileName`: the title as a file name of at most 80 characters, ending `.md`.
pub(crate) fn document_file_name(document: &ProjectDashboardDocument) -> String {
    let mut out = String::new();
    let mut in_bad_run = false;
    for c in document.title.trim().chars() {
        if c.is_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-') {
            in_bad_run = false;
            if c != ' ' || !out.ends_with(' ') {
                out.push(c);
            }
        } else {
            if !in_bad_run {
                out.push('_');
            }
            in_bad_run = true;
        }
    }
    let base: String = out.chars().take(80).collect();
    let base = base.trim();
    let base = if base.is_empty() {
        "project-document"
    } else {
        base
    };
    if base.to_lowercase().ends_with(".md") {
        base.to_owned()
    } else {
        format!("{base}.md")
    }
}

/// The materials page (`DashboardMaterialsPage`).
#[derive(Deserialize)]
struct MaterialsPage {
    status: String,
    #[serde(default)]
    documents: Vec<ProjectDashboardDocument>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

/// The project's documents, every page of them; `Err` when a request or a page fails. An
/// unavailable source ends the list with what was read (`page.status !== "ready"`).
pub(crate) async fn load_documents(
    client: ShellClient,
    project_id: String,
) -> Result<Vec<ProjectDashboardDocument>, ()> {
    let mut cursor: Option<String> = None;
    let mut documents = Vec::new();
    loop {
        let value = client
            .get_project_dashboard_materials(
                &project_id,
                cursor.as_deref(),
                Some(100),
                Some(true),
                None,
            )
            .await
            .map_err(|_| ())?;
        let page: MaterialsPage = serde_json::from_value(value).map_err(|_| ())?;
        if page.status != "ready" {
            break;
        }
        documents.extend(page.documents);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(documents)
}

/// The type's name in the source route (`kind=`).
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

/// `readProjectDocumentPage`: one page of the document's source.
async fn read_page(
    client: &ShellClient,
    document: &ProjectDashboardDocument,
    cursor: Option<&str>,
) -> Result<ProjectDashboardDocument, ()> {
    let (Some(project), Some(revision)) = (&document.project_id, &document.revision) else {
        return if document.markdown.is_empty() {
            Err(())
        } else {
            Ok(document.clone())
        };
    };
    let value = client
        .get_project_dashboard_source(project, type_name(document), &document.id, revision, cursor)
        .await
        .map_err(|_| ())?;
    serde_json::from_value(value).map_err(|_| ())
}

/// `completeProjectDocument`: every page of the source in one text; never a partial report.
async fn complete(client: &ShellClient, document: &ProjectDashboardDocument) -> Result<String, ()> {
    let mut page = read_page(client, document, None).await?;
    let mut markdown = page.markdown.clone();
    let mut seen = std::collections::HashSet::new();
    while let Some(cursor) = page.nextCursor.clone() {
        if !seen.insert(cursor.clone()) {
            return Err(());
        }
        page = read_page(client, &page, Some(&cursor)).await?;
        markdown.push_str(&page.markdown);
    }
    Ok(markdown)
}

/// What attaching a project document came to.
pub(crate) enum DocumentOutcome {
    /// A project-source reference to append to the draft's content parts.
    Source(MessageContentPart),
    /// The document as an uploaded Markdown file.
    Attached(Uploaded),
    /// The attachment failed; the file name for the notice.
    Failed(String),
    /// The chat changed (or the composer closed) meanwhile; nothing to apply or say.
    Stale,
}

/// The source kind a content part can name (`isProjectSourceContentPart`).
fn source_kind(document: &ProjectDashboardDocument) -> Option<ProjectSourceReferenceKind> {
    use ProjectDashboardDocumentType as Type;
    Some(match document_type(document) {
        Type::Plan => ProjectSourceReferenceKind::Plan,
        Type::Task => ProjectSourceReferenceKind::Task,
        Type::Spec => ProjectSourceReferenceKind::Spec,
        Type::Report => ProjectSourceReferenceKind::Report,
        Type::Reference => ProjectSourceReferenceKind::Reference,
        Type::Message => ProjectSourceReferenceKind::Message,
        Type::Work => ProjectSourceReferenceKind::Work,
        Type::Artifact | Type::Roadmap | Type::Unknown => return None,
    })
}

/// `addProjectDocument`: a document with a project and revision becomes a source reference; any
/// other is read whole and uploaded as `<title>.md`. `epoch` is the attachments' epoch cell and
/// `started` its value when the add began.
pub(crate) async fn add_project_document(
    client: ShellClient,
    session_id: Option<String>,
    document: ProjectDashboardDocument,
    topic: Option<String>,
    epoch: Arc<AtomicU64>,
    started: u64,
) -> DocumentOutcome {
    let name = document_file_name(&document);
    let stale = || epoch.load(Ordering::Relaxed) != started;
    if let (Some(project), Some(_)) = (&document.project_id, &document.revision) {
        let Ok(source) = read_page(&client, &document, None).await else {
            return failed(&stale, name);
        };
        if stale() {
            return DocumentOutcome::Stale;
        }
        let (Some(kind), Some(revision)) = (source_kind(&source), source.revision.clone()) else {
            return DocumentOutcome::Failed(name);
        };
        return DocumentOutcome::Source(MessageContentPart::ProjectSourceRef {
            projectId: project.clone(),
            titleSnapshot: topic.clone().unwrap_or_else(|| source.title.clone()),
            topic,
            source: ProjectSourceReference {
                kind,
                id: source.id.clone(),
                revision,
            },
        });
    }
    let Ok(markdown) = complete(&client, &document).await else {
        return failed(&stale, name);
    };
    if stale() {
        return DocumentOutcome::Stale;
    }
    if markdown.len() as u64 > ATTACHMENT_MAX_BYTES {
        return DocumentOutcome::Failed(name);
    }
    let uploaded = upload_bytes(
        &client,
        session_id.as_deref(),
        &name,
        "text/markdown",
        markdown.into_bytes(),
    )
    .await;
    if stale() {
        return DocumentOutcome::Stale;
    }
    match uploaded {
        Ok((file, _)) => DocumentOutcome::Attached((
            ComposerAttachment {
                id: format!("project-document-{}-{}", document.id, super::next_serial()),
                kind: file.kind.clone(),
                file,
            },
            Extra {
                project_document: true,
                preview: None,
            },
        )),
        Err(()) => DocumentOutcome::Failed(name),
    }
}

/// A failure, unless the chat changed meanwhile.
fn failed(stale: &impl Fn() -> bool, name: String) -> DocumentOutcome {
    if stale() {
        DocumentOutcome::Stale
    } else {
        DocumentOutcome::Failed(name)
    }
}

/// The toast of a project document that could not be attached.
pub(crate) fn document_failed_notice(name: &str, cx: &App) -> Toast {
    Toast::error((copy(Ds::get(cx).lang()).upload_failed)(name))
}
