//! DS CopyButton (CopyButton.tsx): DoneIconButton's copy action. It writes its text to the
//! clipboard through gpui, then shows the shared icon-to-check morph.
use std::rc::Rc;

use gpui::{App, ClipboardItem, ElementId, IntoElement, RenderOnce, SharedString, Task, Window};

use super::Icon;
use super::context::Ds;
use super::done_icon_button::DoneIconButton;
use super::icon::{IconSize, icon};

type Text = Rc<dyn Fn() -> String>;
type Copied = Rc<dyn Fn(&mut App)>;

#[derive(IntoElement)]
pub struct CopyButton {
    id: ElementId,
    label: SharedString,
    copied_label: SharedString,
    text: Option<Text>,
    on_copy: Option<Copied>,
    copied: Option<bool>,
}

impl CopyButton {
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        copied_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            copied_label: copied_label.into(),
            text: None,
            on_copy: None,
            copied: None,
        }
    }

    /// The text to copy.
    pub fn text(mut self, text: impl Into<String>) -> Self {
        let text = text.into();
        self.text = Some(Rc::new(move || text.clone()));
        self
    }

    /// A function that returns the text at click time.
    pub fn text_with(mut self, text: impl Fn() -> String + 'static) -> Self {
        self.text = Some(Rc::new(text));
        self
    }

    /// Parent-driven copy: called instead of writing the text to the clipboard.
    pub fn on_copy(mut self, on_copy: impl Fn(&mut App) + 'static) -> Self {
        self.on_copy = Some(Rc::new(on_copy));
        self
    }

    /// Parent-driven copied state; overrides the internal feedback state.
    pub fn copied(mut self, copied: bool) -> Self {
        self.copied = Some(copied);
        self
    }
}

impl RenderOnce for CopyButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let glyph = icon(Icon::Copy, IconSize::Sm, Ds::get(cx));
        // A parent-driven copy shows only the parent's copied state.
        let done = self.copied.or(self.on_copy.as_ref().map(|_| false));
        let (text, on_copy) = (self.text, self.on_copy);
        let mut button = DoneIconButton::new(self.id, self.label, self.copied_label)
            .icon(glyph)
            .on_action(move |_, cx: &mut App| {
                match &on_copy {
                    Some(on_copy) => on_copy(cx),
                    None => {
                        let text = text.as_ref().map(|text| text()).unwrap_or_default();
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                }
                Task::ready(Ok(()))
            });
        if let Some(done) = done {
            button = button.done(done);
        }
        button
    }
}
