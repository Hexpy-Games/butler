//! The shell's text field (the composer and the suggest-a-change dialog): gpui-ce's
//! EditableText in Pretendard 14/20 and the theme's text colours, wrapping, growing to
//! eight lines and scrolling past them.
use gpui::{Action as _, Entity, FontWeight, KeyBinding, Unbind, prelude::*, px};
use gpui_elements::editable_text::actions::{self, DEFAULT_INPUT_CONTEXT};
use gpui_elements::editable_text::{EditableTextElement, EditableTextState, text_area};

use crate::ui::theme::{FONT_BODY, Theme, alpha};

/// Eight 20 px lines; the field scrolls past them.
const MAX_HEIGHT: f32 = 8. * 20.;

/// EditableText's keys. Enter belongs to the field's owner (`composer::Submit`, bound after
/// these), Shift+Enter is the newline, Tab and Escape are not editing keys, and Home/End
/// move within the line on every platform.
pub(crate) fn bindings() -> Vec<KeyBinding> {
    let c = Some(DEFAULT_INPUT_CONTEXT);
    let mut keys: Vec<KeyBinding> = actions::default_bindings().as_keybindings(c).collect();
    keys.extend([
        KeyBinding::new("enter", Unbind(actions::Enter.name().into()), c),
        KeyBinding::new("tab", Unbind(actions::Tab.name().into()), c),
        KeyBinding::new("escape", Unbind(actions::Escape.name().into()), c),
        KeyBinding::new("shift-enter", actions::Enter, c),
        KeyBinding::new("home", actions::NavLineStart, c),
        KeyBinding::new("end", actions::NavLineEnd, c),
    ]);
    keys
}

/// The field for `state`, styled from the theme.
pub(crate) fn field(
    id: &'static str,
    state: &Entity<EditableTextState>,
    placeholder: &'static str,
    t: &Theme,
) -> EditableTextElement {
    text_area(id)
        .state(state.downgrade())
        .placeholder(placeholder)
        .placeholder_color(t.placeholder)
        .selection_color(alpha(t.accent, 0.28))
        .caret_color(t.text)
        .marked_color(t.text)
        .caret_w(px(1.))
        .w_full()
        .max_h(px(MAX_HEIGHT))
        .overflow_y_scroll()
        .font_family(FONT_BODY)
        .font_weight(FontWeight::NORMAL)
        .text_size(px(14.))
        .line_height(px(20.))
        .text_color(t.text)
}
