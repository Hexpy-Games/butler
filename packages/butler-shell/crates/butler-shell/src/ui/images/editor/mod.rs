//! `ImageEditor.tsx`: the mask editor in the conversation's right slot. The user paints what
//! should change, says how, and the edit turn's picture replaces the shown one.
mod strip;
mod toolbar;
mod turn;

use gpui::AppContext as _;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::mask_canvas::{MaskCanvas, MaskCanvasState, MaskTool};
use butler_ds::ui::button::{self, Button};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box as Pad, Cross, Justify, Space, Stack, WithItem as _};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::text::Textarea;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::Typo;
use butler_shell_client::{Error, ShellClient};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, ImageSource, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Subscription,
    Window, div,
};
use serde::Deserialize;
use serde_json::{Value, json};

use self::turn::EditTurn;
use super::copy::{Words, words};
use super::{EditorTarget, Env, ImageAsset, actions, api, close_editor};
use crate::ui::manage::live::Topic;
use crate::ui::source::fetch::fetch;
use crate::ui::widgets::anchor;

pub(super) struct ImageEditor {
    session: SharedString,
    initial: Rc<ImageAsset>,
    /// The shown version.
    asset: Rc<ImageAsset>,
    versions: Vec<Rc<ImageAsset>>,
    tool: MaskTool,
    size: f32,
    compare: bool,
    text: SharedString,
    sending: bool,
    mask: Entity<MaskCanvasState>,
    turn: EditTurn,
    focus: FocusHandle,
    focused: bool,
    _live: Option<Subscription>,
    _mask: Subscription,
}

/// `POST /messages` answer: the accepted message.
#[derive(Deserialize)]
struct Sent {
    #[serde(default)]
    accepted: Option<Accepted>,
}

#[derive(Deserialize)]
struct Accepted {
    #[serde(default)]
    turn_id: Option<String>,
}

/// The mask upload (when something is painted), then the edit message (`sendMessage` with
/// `imageEdit`, `send_now`).
async fn post_edit(
    client: &ShellClient,
    session: &str,
    image: &str,
    text: &str,
    mask: Option<Vec<u8>>,
    access_mode: Option<String>,
) -> Result<Value, Error> {
    let mut edit = json!({ "image": image });
    if let Some(bytes) = mask {
        let uploaded = client.upload_image_mask(session, image, bytes).await?;
        if let Some(id) = uploaded.get("id").and_then(Value::as_str) {
            edit["mask"] = json!(id);
        }
    }
    let mut body = json!({
        "chat_id": session, "text": text, "image_edit": edit, "queue_policy": "send_now",
        "client_message_id": uuid::Uuid::new_v4().to_string(),
    });
    if let Some(mode) = access_mode {
        body["access_mode"] = json!(mode);
    }
    client.send_message(&body).await
}

impl ImageEditor {
    pub(super) fn new(target: EditorTarget, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let EditorTarget { session, asset } = target;
        let mask = cx.new(|_| MaskCanvasState::new(asset.width, asset.height, Vec::new()));
        let live = cx
            .try_global::<Env>()
            .and_then(|env| env.live.clone())
            .map(|live| {
                let topic = Topic::Session(session.clone());
                cx.observe(&live, move |this, live, cx| {
                    let revision = live.read(cx).revision(&topic);
                    if this.turn.generating() && revision != this.turn.seen {
                        this.turn.seen = revision;
                        this.refresh_turn(cx);
                    }
                })
            });
        let focus = cx.focus_handle();
        let mut editor = Self {
            session,
            initial: asset.clone(),
            asset: asset.clone(),
            versions: vec![asset],
            tool: MaskTool::Brush,
            size: 32.,
            compare: false,
            text: SharedString::default(),
            sending: false,
            _mask: cx.observe(&mask, |_, _, cx| cx.notify()),
            mask,
            turn: EditTurn::default(),
            focus,
            focused: false,
            _live: live,
        };
        editor.load_versions(cx);
        editor
    }

    fn copy(cx: &App) -> &'static Words {
        words(Ds::get(cx).lang())
    }

    fn locked(&self) -> bool {
        self.sending || self.turn.generating() || self.turn.result.is_some()
    }

    fn undo(&mut self, cx: &mut Context<Self>) {
        self.mask.update(
            cx,
            butler_ds::ui::blocks::mask_canvas::MaskCanvasState::undo,
        );
    }

    fn set_compare(&mut self, held: bool, cx: &mut Context<Self>) {
        if self.compare != held {
            self.compare = held;
            cx.notify();
        }
    }

    /// `getImageVersions` for the shown picture.
    fn load_versions(&mut self, cx: &mut Context<Self>) {
        let id = self.asset.id.clone();
        let asked = id.clone();
        fetch(
            cx,
            move |client| async move { client.get_message_asset_versions(&id).await },
            move |this: &mut Self, result: Result<Vec<ImageAsset>, Error>, _| {
                if let Ok(versions) = result
                    && this.asset.id == asked
                {
                    this.versions = versions.into_iter().map(Rc::new).collect();
                }
            },
        );
    }

    /// `selectVersion`: shows another version of the picture.
    fn select_version(&mut self, next: Rc<ImageAsset>, cx: &mut Context<Self>) {
        self.compare = false;
        let (width, height) = (next.width, next.height);
        self.asset = next;
        self.mask
            .update(cx, |mask, cx| mask.reset(width, height, cx));
        self.load_versions(cx);
        cx.notify();
    }

    /// The edit turn's picture is on screen: it becomes the shown version.
    fn result_shown(&mut self, cx: &mut Context<Self>) {
        if let Some(result) = self.turn.result.clone() {
            self.select_version(result, cx);
            self.mask.update(cx, |mask, cx| {
                mask.clear(cx);
            });
            self.turn.shown();
        }
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        let copy = Self::copy(cx);
        if actions::edit_blocked(copy, cx).is_some() || self.locked() || self.text.trim().is_empty()
        {
            return;
        }
        self.sending = true;
        cx.notify();
        let mask = self.mask.read(cx).to_mask_png();
        let access_mode = super::access_mode(cx);
        let (session, image, text) = (
            self.session.to_string(),
            self.asset.id.clone(),
            self.text.to_string(),
        );
        fetch(
            cx,
            move |client| async move {
                post_edit(&client, &session, &image, &text, mask, access_mode).await
            },
            move |this: &mut Self, result: Result<Sent, Error>, cx| {
                this.sending = false;
                match result
                    .ok()
                    .and_then(|sent| sent.accepted)
                    .and_then(|a| a.turn_id)
                {
                    Some(turn) => {
                        this.text = SharedString::default();
                        this.turn_accepted(turn, cx);
                    }
                    None => {
                        toast::show(cx, Toast::error(copy.failed));
                    }
                }
            },
        );
    }

    /// Escape, undo and the tool keys, while no text field has the keys.
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus.is_focused(window) {
            return;
        }
        let (key, modifiers) = (event.keystroke.key.as_str(), event.keystroke.modifiers);
        if key == "escape" {
            cx.stop_propagation();
            close_editor(cx);
            return;
        }
        if self.locked() {
            return;
        }
        if (modifiers.platform || modifiers.control) && key == "z" {
            cx.stop_propagation();
            self.undo(cx);
        } else if !(modifiers.platform || modifiers.control || modifiers.alt) {
            match key {
                "b" => self.tool = MaskTool::Brush,
                "e" => self.tool = MaskTool::Eraser,
                "[" => self.size = (self.size - 4.).max(4.),
                "]" => self.size = (self.size + 4.).min(160.),
                _ => return,
            }
            cx.notify();
        }
    }

    fn canvas(&self, cx: &mut Context<Self>) -> AnyElement {
        let copy = Self::copy(cx);
        let original = self
            .versions
            .iter()
            .find(|v| v.parent_id.is_none())
            .unwrap_or(&self.initial);
        let mut canvas = MaskCanvas::new(
            "image-editor-canvas",
            self.mask.clone(),
            source(&self.asset, cx),
            copy.editor,
        )
        .tool(self.tool)
        .brush_size(self.size)
        .generating(self.sending || self.turn.generating())
        .on_result_shown({
            let this = cx.entity().downgrade();
            move |_, cx| {
                let _ = this.update(cx, ImageEditor::result_shown);
            }
        });
        if self.locked() {
            canvas = canvas.disabled(true);
        }
        if self.compare {
            canvas = canvas.compare_src(Some(source(original, cx)));
        }
        if let Some(result) = self.turn.result.clone() {
            canvas = canvas.result_src(Some(source(&result, cx)));
        }
        canvas.into_any_element()
    }

    fn footer(&self, copy: &Words, cx: &mut Context<Self>) -> AnyElement {
        let blocked = actions::edit_blocked(copy, cx);
        let locked = self.locked();
        let mut send = Button::new("image-editor-send").text(copy.send);
        if locked {
            send = send.icon_start(Spinner::new("image-editor-sending"));
        }
        if blocked.is_some() || locked || self.text.trim().is_empty() {
            send = send.disabled();
        } else {
            send = send.on_click(cx.listener(|this, _, _, cx| this.send(cx)));
        }
        let send = match blocked {
            Some(reason) => Tooltip::new("image-editor-send-tip")
                .label(reason)
                .child(send)
                .into_any_element(),
            None => send.into_any_element(),
        };
        Pad::new()
            .padding(Space::Md)
            .child(
                button::container(button::Size::Sm)
                    .justify(Justify::End)
                    .child(send),
            )
            .into_any_element()
    }
}

/// The picture once the shared loader has it; the empty source until then.
fn source(asset: &ImageAsset, cx: &mut App) -> ImageSource {
    api::loaded(&asset.id, cx).unwrap_or_else(|| ImageSource::from(String::new()))
}

impl Render for ImageEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.focused {
            self.focused = true;
            window.focus(&self.focus, cx);
        }
        self.sync_turn(cx);
        let copy = Self::copy(cx);
        let strokes = self.mask.read(cx).strokes();
        let header = Pad::new().padding(Space::Md).child(
            Stack::row()
                .justify(Justify::Between)
                .cross(Cross::Center)
                .shrink(false)
                .child(Typo::label(copy.editor))
                .child(
                    IconButton::new("image-editor-close", copy.close)
                        .glyph(Icon::X)
                        .on_click(|_, _, cx| close_editor(cx)),
                ),
        );
        let tools = Pad::new()
            .padding_x(Space::Md)
            .child(self.toolbar(copy, strokes, window, cx));
        let canvas = Pad::new()
            .padding_x(Space::Md)
            .grow()
            .child(self.canvas(cx));
        let instruction = Textarea::new("image-editor-instruction")
            .placeholder(copy.instruction)
            .value(self.text.clone())
            .on_change(cx.listener(|this, value: &str, _, cx| {
                this.text = value.to_owned().into();
                cx.notify();
            }));
        let stack = Stack::new()
            .fill()
            .child(header)
            .child(tools)
            .child(canvas)
            .child(self.version_strip(cx))
            .child(Pad::new().padding_x(Space::Md).child(instruction))
            .child(self.footer(copy, cx));
        anchor(div().id("image-editor"), "image-editor")
            .size_full()
            .track_focus(&self.focus)
            .on_key_down(
                cx.listener(|this, event: &KeyDownEvent, window, cx| this.key(event, window, cx)),
            )
            .child(stack)
    }
}
