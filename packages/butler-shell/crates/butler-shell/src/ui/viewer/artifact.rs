//! `artifacts/ArtifactViewer`, `ArtifactBody`, `artifactDisplay`, `useArtifactText`,
//! `artifactActions`, `FileViewerArtifact` and `FileViewerDocument` (markdown, image, pdf,
//! code/text).
mod display;
mod files;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::artifact_preview::{
    ArtifactPreview, ArtifactPreviewFrame, ArtifactPreviewImage, ArtifactPreviewPre, Surface,
};
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::typo::Typo;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, ImageSource, IntoElement as _, ParentElement as _, SharedString,
    Window,
};

use self::display::{Mode, meta_line, preview_mode, revision_artifact};
use self::files::{TextState, artifact_text, save_file};
use super::FileViewerEntry;
use super::frame::{
    FileViewerAction, FileViewerHeader, FileViewerPage, Run, file_viewer_close_button,
};
use crate::ui::i18n::artifact_viewer::ArtifactViewerCopy;
use crate::ui::i18n::media::Media;
use crate::ui::manage::documents;
use crate::ui::shell::image_viewer::loader::{PictureId, is_pending, picture};
use crate::ui::source::wire::SessionArtifactSummary;

/// The open file: its title row and its page.
pub(crate) fn artifact_viewer(
    session: &str,
    entry: &FileViewerEntry,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (id, session) = (entry.id().to_owned(), session.to_owned());
    let on_close: Run = Rc::new(move |_, cx| super::close(cx, &session, &id));
    match entry {
        FileViewerEntry::Artifact { artifact, .. } => {
            file_viewer_artifact(artifact, on_close, window, cx)
        }
        FileViewerEntry::Document { id, title } => document_viewer(id, title, on_close, window, cx),
    }
}

/// `FileViewerDocument`: the documents feature's page, whose title row carries the close
/// control; the viewer adds no header. Without the window's `ManageCtx` the title row and an
/// empty line stand in.
fn document_viewer(
    id: &str,
    title: &str,
    on_close: Run,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let close = on_close.clone();
    let trailing: documents::Slot =
        Rc::new(move |_, cx| file_viewer_close_button(close.clone(), cx).into_any_element());
    if let Some(page) = documents::viewer_page(id, (None, trailing), window, cx) {
        return FileViewerPage::new(true).child(page).into_any_element();
    }
    Stack::new()
        .fill()
        .gap(Space::None)
        .child(FileViewerHeader {
            title: title.to_owned().into(),
            meta: None,
            leading: None,
            actions: Vec::new(),
            on_close,
            on_back: None,
        })
        .child(
            FileViewerPage::new(true)
                .child(EmptyLine::new(ArtifactViewerCopy::get(cx).unsupported)),
        )
        .into_any_element()
}

/// `artifactPreviewMode(artifact) === "image"`, for the viewer's tab icons.
pub(super) fn is_image_artifact(artifact: &SessionArtifactSummary) -> bool {
    preview_mode(artifact) == Mode::Image
}

/// `FileViewerArtifact`: a stored file in the viewer: its header (version, save, close) and its
/// content as a reading page.
fn file_viewer_artifact(
    latest: &SessionArtifactSummary,
    on_close: Run,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let index = revision_index(latest, window, cx);
    let artifact = revision_artifact(latest, index);
    let mode = preview_mode(&artifact);
    // The Library link and "open in the default app" have no route in the shell yet.
    let mut actions = Vec::new();
    if let Some(file_id) = artifact.file_id.clone() {
        let name = file_name(&artifact);
        actions.push(FileViewerAction {
            id: "save",
            label: Media::get(cx).save.into(),
            icon: Icon::Save,
            label_icon: false,
            icon_only: false,
            run: Rc::new(move |_, cx| save_file(file_id.clone(), &name, cx)),
        });
    }
    let select = revision_select(latest, index, window, cx);
    Stack::new()
        .fill()
        .gap(Space::None)
        .child(FileViewerHeader {
            title: artifact.title.clone().into(),
            meta: Some(meta_line(&artifact, cx).into()),
            leading: Some(select),
            actions,
            on_close,
            on_back: None,
        })
        .child(
            FileViewerPage::new(mode == Mode::Markdown).child(artifact_body(
                &artifact,
                Surface::Page,
                window,
                cx,
            )),
        )
        .into_any_element()
}

/// The name a saved copy keeps: its own path label, else the title.
fn file_name(artifact: &SessionArtifactSummary) -> String {
    artifact
        .safe_path_label
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| artifact.title.clone())
}

/// The chosen version of the artifact (`choice`, kept per artifact id).
fn revision_index(latest: &SessionArtifactSummary, window: &mut Window, cx: &mut App) -> usize {
    let state = window.use_keyed_state(
        SharedString::from(format!("artifact-revision-{}", latest.id)),
        cx,
        |_, _| 0usize,
    );
    *state.read(cx)
}

/// `ArtifactRevisionSelect`: the artifact's Library versions (newest first), when it has more
/// than one.
fn revision_select(
    artifact: &SessionArtifactSummary,
    index: usize,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let revisions = artifact.revisions.as_deref().unwrap_or_default();
    if revisions.len() < 2 {
        return gpui::Empty.into_any_element();
    }
    let label = ArtifactViewerCopy::get(cx).revision;
    let key = SharedString::from(format!("artifact-revision-{}", artifact.id));
    let state = window.use_keyed_state(key.clone(), cx, |_, _| 0usize);
    let count = revisions.len();
    let select = (0..count).fold(
        NativeSelect::new(ElementId::from(key))
            .value(index.to_string())
            .on_change(move |value, window, cx| {
                let next = value.parse().unwrap_or(0);
                state.update(cx, |state, cx| {
                    *state = next;
                    cx.notify();
                });
                window.refresh();
            }),
        |select, position| {
            select.option(
                position.to_string(),
                format!("{label} {}", count - position),
            )
        },
    );
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .wrap(true)
        .child(select)
        .into_any_element()
}

/// `ArtifactBody`: an artifact's content: markdown, a picture, a PDF, code or text in
/// monospace. A page Butler made (web, html) is the P5 browser's: here the empty frame box.
fn artifact_body(
    artifact: &SessionArtifactSummary,
    surface: Surface,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mode = preview_mode(artifact);
    let content = render_preview(mode, artifact, surface, window, cx);
    ArtifactPreview::new(ElementId::from(SharedString::from(format!(
        "artifact-preview-{}",
        artifact.id
    ))))
    .surface(surface)
    .child(content)
    .into_any_element()
}

/// `renderPreview`.
fn render_preview(
    mode: Mode,
    artifact: &SessionArtifactSummary,
    surface: Surface,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let copy = ArtifactViewerCopy::get(cx);
    let caption = |text: &'static str| Typo::caption(text).into_any_element();
    if matches!(mode, Mode::Web | Mode::Html) {
        return ArtifactPreviewFrame::new().into_any_element();
    }
    let Some(file_id) = artifact
        .file_id
        .clone()
        .filter(|_| mode != Mode::Unsupported)
    else {
        return unsupported(artifact, surface, cx);
    };
    match mode {
        Mode::Image => image(&file_id, window, cx),
        Mode::Pdf => ArtifactPreviewFrame::new().into_any_element(),
        _ => match artifact_text(&file_id, cx) {
            TextState::Loading => caption(copy.loading),
            TextState::Failed => caption(copy.load_failed),
            TextState::Ready(text) if mode == Mode::Markdown => {
                let media = Media::get(cx);
                MarkdownContent::new(SharedString::from(format!("artifact-md-{file_id}")), text)
                    .copy_code(media.copy_code, media.copied)
                    .into_any_element()
            }
            TextState::Ready(text) => ArtifactPreviewPre::new(text).into_any_element(),
        },
    }
}

/// What an unpreviewable file offers instead: its caption, and Save in a card.
fn unsupported(artifact: &SessionArtifactSummary, surface: Surface, cx: &App) -> AnyElement {
    let stack = Stack::new().child(Typo::caption(ArtifactViewerCopy::get(cx).unsupported));
    let Some(file_id) = artifact
        .file_id
        .clone()
        .filter(|_| surface == Surface::Card)
    else {
        return stack.into_any_element();
    };
    let name = file_name(artifact);
    stack
        .child(
            Button::new(SharedString::from(format!("artifact-save-{file_id}")))
                .variant(Variant::Outline)
                .size(Size::Sm)
                .text(Media::get(cx).save)
                .on_click(move |_, _, cx| save_file(file_id.clone(), &name, cx)),
        )
        .into_any_element()
}

/// `ArtifactPreviewImage` of the stored picture, at its own display size.
fn image(file_id: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    let copy = ArtifactViewerCopy::get(cx);
    let id = PictureId::File(file_id.to_owned());
    let Some(source) = picture(&id, cx) else {
        let text = if is_pending(&id, cx) {
            copy.loading
        } else {
            copy.load_failed
        };
        return Typo::caption(text).into_any_element();
    };
    let Some(render) = source.clone().use_render_image(window, cx) else {
        return Typo::caption(copy.loading).into_any_element();
    };
    let size = render.size(0);
    let scale = window.scale_factor();
    let natural = (size.width.0 as f32 / scale, size.height.0 as f32 / scale);
    ArtifactPreviewImage::new(ImageSource::Image(source), natural).into_any_element()
}
