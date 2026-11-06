//! DS Textarea (shadcn/ui/textarea.tsx): several lines of text in the default box (optionally
//! growing with the text), or the underline that grows a whole line at a time.
use gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window};

use super::TextSize;
use super::field::{self, Look, Shape, Spec};

/// `variant`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Default,
    /// Wrapping in-place entry, growing from one line to `--textarea-max-lines`, then scrolling
    /// under the edge fade.
    Underline,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent HTML attributes of one field"
)]
#[derive(IntoElement)]
pub struct Textarea {
    id: ElementId,
    variant: Variant,
    text_size: TextSize,
    auto_grow: bool,
    rows: Option<u32>,
    placeholder: Option<SharedString>,
    default_value: SharedString,
    value: Option<SharedString>,
    disabled: bool,
    read_only: bool,
    invalid: bool,
    probe: Option<SharedString>,
}

impl Textarea {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            variant: Variant::Default,
            text_size: TextSize::Inherit,
            auto_grow: false,
            rows: None,
            placeholder: None,
            default_value: SharedString::default(),
            value: None,
            disabled: false,
            read_only: false,
            invalid: false,
            probe: None,
        }
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    /// The underline's text metrics: the surrounding text or `--typo-label-*`.
    pub fn text_size(mut self, text_size: TextSize) -> Self {
        self.text_size = text_size;
        self
    }

    /// Default variant: grow with the text from the minimum height to
    /// `--textarea-grow-max-lines`, then scroll.
    pub fn auto_grow(mut self) -> Self {
        self.auto_grow = true;
        self
    }

    /// The height in lines (`rows`); the box is never shorter than its minimum height.
    pub fn rows(mut self, rows: u32) -> Self {
        self.rows = Some(rows);
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

    /// See [`super::Input::probe`].
    pub fn probe(mut self, name: impl Into<SharedString>) -> Self {
        self.probe = Some(name.into());
        self
    }
}

impl RenderOnce for Textarea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let underline = self.variant == Variant::Underline;
        field::render(
            Spec {
                id: self.id,
                look: if underline {
                    Look::Underline
                } else {
                    Look::Default
                },
                text_size: self.text_size,
                shape: Shape::Area {
                    rows: self.rows,
                    grow: self.auto_grow && !underline,
                },
                placeholder: self.placeholder,
                initial: self.default_value,
                value: self.value,
                disabled: self.disabled,
                read_only: self.read_only,
                invalid: self.invalid,
                probe: self.probe,
            },
            window,
            cx,
        )
    }
}
