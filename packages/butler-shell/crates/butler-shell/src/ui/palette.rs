//! The command palette (`components/command/*` on the DS CommandPanel).
use gpui::{Context, EventEmitter, FocusHandle, Focusable, IntoElement, Render, Window, div};

/// What the palette asks the shell to do.
#[derive(Clone, Debug)]
pub(crate) enum PaletteEvent {
    Dismissed,
}

/// `CommandPalette`.
pub(crate) struct CommandPalette {
    focus: FocusHandle,
}

impl CommandPalette {
    pub(crate) fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
        }
    }

    /// Opens the palette (mod+K, the sidebar search row).
    pub(crate) fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = (window, cx);
    }
}

impl EventEmitter<PaletteEvent> for CommandPalette {}

impl Focusable for CommandPalette {
    fn focus_handle(&self, _cx: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for CommandPalette {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}
