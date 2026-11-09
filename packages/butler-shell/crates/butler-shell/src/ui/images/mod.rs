//! Generated images, their actions and the mask editor (`images/GeneratedImages.tsx`,
//! `GeneratedImageCard.tsx`, `useImageOutputs.ts`, `imageApi.ts`, `ImageEditor.tsx`,
//! `imageEditorState.ts`).
mod actions;
mod api;
mod card;
mod copy;
mod editor;
mod outputs;
mod ready;

use gpui::AppContext as _;
use std::rc::Rc;

use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, Entity, Global, IntoElement as _, ParentElement as _, SharedString, Window,
};
use serde::Deserialize;

use self::editor::ImageEditor;
use crate::ui::manage::live::ManageLive;

/// `ImageAsset` (imageApi.ts): `/message-assets/{id}/meta`.
#[allow(dead_code, reason = "wire shape of imageApi.ts ImageAsset")]
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct ImageAsset {
    pub(crate) id: String,
    pub(crate) img: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) image_url: String,
    #[serde(default)]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) mime: Option<String>,
}

/// One `generate_image` / `edit_image` call of the turn with its result to read.
#[allow(dead_code, reason = "wire shape of the tool row")]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ImageToolRow {
    pub(crate) call_id: SharedString,
    pub(crate) result_id: SharedString,
    pub(crate) tool: SharedString,
    /// The row failed (`state == "failed"` or a failure code).
    pub(crate) failed: bool,
}

/// What `GeneratedImages` reads of the message.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GeneratedImagesInput {
    pub(crate) turn: Option<SharedString>,
    pub(crate) session: SharedString,
    /// `${status}:${updated_at}`: unresolved outputs are read again when it moves.
    pub(crate) revision: SharedString,
    pub(crate) rows: Vec<ImageToolRow>,
    /// The request's first line, at most 80 characters (the card's title).
    pub(crate) title: SharedString,
}

/// `GeneratedImages`: the turn's images under the reply; `None` when it has none.
pub(crate) fn generated_images(
    input: &GeneratedImagesInput,
    _window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let read = outputs::read(input.turn.as_deref(), &input.rows, &input.revision, cx);
    if read.images.is_empty() {
        return None;
    }
    let cards: Vec<AnyElement> = (0..read.images.len())
        .map(|index| card::card(&read.images, index, &input.session, &input.title, cx))
        .collect();
    Some(
        Stack::new()
            .gap(Space::Md)
            .children(cards)
            .into_any_element(),
    )
}

/// `imageEditorState.target`: the image being edited and its conversation.
#[derive(Clone, Debug)]
pub(crate) struct EditorTarget {
    pub(crate) session: SharedString,
    pub(crate) asset: Rc<ImageAsset>,
}

/// The editor's target and the entity that edits it.
#[derive(Default)]
struct Editor {
    target: Option<EditorTarget>,
    view: Option<Entity<ImageEditor>>,
}

impl Global for Editor {}

/// What the editor needs of the shell: the live topics (the edit turn's progress) and the
/// composer's access mode (`useComposerStore.accessMode`).
#[derive(Default)]
struct Env {
    live: Option<Entity<ManageLive>>,
    access_mode: String,
}

impl Global for Env {}

/// The shell gives the editor its live topics once at init.
pub(crate) fn install(live: Entity<ManageLive>, cx: &mut App) {
    cx.default_global::<Env>().live = Some(live);
}

/// The composer's access mode (wire name): `read_only` makes the edit buttons say so and stay off,
/// and an edit is sent under it.
pub(crate) fn set_access_mode(mode: &str, cx: &mut App) {
    if cx.default_global::<Env>().access_mode != mode {
        mode.clone_into(&mut cx.default_global::<Env>().access_mode);
        cx.refresh_windows();
    }
}

fn access_mode(cx: &App) -> Option<String> {
    cx.try_global::<Env>()
        .map(|env| env.access_mode.clone())
        .filter(|mode| !mode.is_empty())
}

fn read_only(cx: &App) -> bool {
    access_mode(cx).is_some_and(|mode| mode == "read_only")
}

/// The image being edited, if any.
pub(crate) fn editor_target(cx: &App) -> Option<EditorTarget> {
    cx.try_global::<Editor>()
        .and_then(|editor| editor.target.clone())
}

/// `openImageEditor`: the editor takes the conversation's right slot.
pub(crate) fn open_editor(session: SharedString, asset: Rc<ImageAsset>, cx: &mut App) {
    crate::ui::shell::image_viewer::close(cx);
    ready::refresh(cx);
    cx.set_global(Editor {
        target: Some(EditorTarget { session, asset }),
        view: None,
    });
    cx.refresh_windows();
}

/// `closeImageEditor`
pub(crate) fn close_editor(cx: &mut App) {
    if editor_target(cx).is_some() {
        cx.set_global(Editor::default());
        cx.refresh_windows();
    }
}

/// `ImageEditor` in the right slot, while [`editor_target`] names the open conversation.
pub(crate) fn editor_pane(window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let target = editor_target(cx)?;
    let view = match cx
        .try_global::<Editor>()
        .and_then(|editor| editor.view.clone())
    {
        Some(view) => view,
        None => {
            let view = cx.new(|cx| ImageEditor::new(target, window, cx));
            cx.default_global::<Editor>().view = Some(view.clone());
            view
        }
    };
    Some(view.into_any_element())
}

/// `GeneratedImageActions` for the image viewer (`media/ImageViewerHost.tsx:23`): edit, save to
/// 서랍 and download of the shown generated picture. The viewer calls it for a picture that
/// carries its asset and conversation.
pub(crate) fn viewer_actions(
    asset: &Rc<ImageAsset>,
    session: &str,
    title: &str,
    cx: &mut App,
) -> Vec<AnyElement> {
    let key = format!("viewer-image-{}", asset.id);
    actions::buttons(asset, session, title, &key, cx)
}
