//! DS Input (shadcn/ui/input.tsx): one line of text in the default box, the quiet box that
//! fills in on focus, or the underline for in-place entry.
use gpui::{App, ElementId, IntoElement, Pixels, RenderOnce, SharedString, Window};

use super::TextSize;
use std::rc::Rc;

use super::field::{self, ChangeHandler, Look, Shape, Spec};

/// `variant`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Default,
    /// The default border without the fill at rest (a sidebar search); the default field on focus.
    Quiet,
    /// A bottom line for in-place entry, on the surrounding text baseline.
    Underline,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent HTML attributes of one field"
)]
#[derive(IntoElement)]
pub struct Input {
    id: ElementId,
    variant: Variant,
    compact: bool,
    padding_inline: Option<(Pixels, Pixels)>,
    text_size: TextSize,
    placeholder: Option<SharedString>,
    default_value: SharedString,
    value: Option<SharedString>,
    disabled: bool,
    read_only: bool,
    invalid: bool,
    masked: bool,
    probe: Option<SharedString>,
    on_change: Option<ChangeHandler>,
}

impl Input {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            variant: Variant::Default,
            compact: false,
            padding_inline: None,
            text_size: TextSize::Inherit,
            placeholder: None,
            default_value: SharedString::default(),
            value: None,
            disabled: false,
            read_only: false,
            invalid: false,
            masked: false,
            probe: None,
            on_change: None,
        }
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    /// A short inline field (numbers in a toolbar): content width, small control height.
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// CSS `padding-inline` of the text box (the border is outside it). Unset keeps the field's own padding.
    pub fn padding_inline(mut self, start: Pixels, end: Pixels) -> Self {
        self.padding_inline = Some((start, end));
        self
    }

    /// The underline's text metrics: the surrounding text or `--typo-label-*`.
    pub fn text_size(mut self, text_size: TextSize) -> Self {
        self.text_size = text_size;
        self
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    /// The text the field starts with (`defaultValue`).
    pub fn default_value(mut self, value: impl Into<SharedString>) -> Self {
        self.default_value = value.into();
        self
    }

    /// The text the field shows, set by the owner on every render (`value`).
    pub fn value(mut self, value: impl Into<SharedString>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// `readOnly`. The editor takes no input, and no focus or selection either.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// `aria-invalid="true"`.
    pub fn invalid(mut self) -> Self {
        self.invalid = true;
        self
    }

    /// `onChange`: the text after each edit the user makes (not after `value` replaces it).
    /// `type="password"`: shows a mask dot per character and keeps the text off the clipboard.
    pub fn masked(mut self) -> Self {
        self.masked = true;
        self
    }

    pub fn on_change(mut self, handler: impl Fn(&str, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    /// Names zero-size markers that report the field's text, caret and IME marked range
    /// (`<name>:<text>`, `<name>:caret:<n>`, `<name>:marked:<a>-<b>|none`), for a harness
    /// expectation. Only the test build draws them.
    pub fn probe(mut self, name: impl Into<SharedString>) -> Self {
        self.probe = Some(name.into());
        self
    }
}

impl RenderOnce for Input {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let look = match self.variant {
            Variant::Default => Look::Default,
            Variant::Quiet => Look::Quiet,
            Variant::Underline => Look::Underline,
        };
        field::render(
            Spec {
                id: self.id,
                look,
                text_size: self.text_size,
                shape: Shape::Line {
                    compact: self.compact && look != Look::Underline,
                    padding_inline: self.padding_inline,
                },
                placeholder: self.placeholder,
                initial: self.default_value,
                value: self.value,
                disabled: self.disabled,
                read_only: self.read_only,
                invalid: self.invalid,
                masked: self.masked,
                probe: self.probe,
                on_change: self.on_change,
            },
            window,
            cx,
        )
    }
}
