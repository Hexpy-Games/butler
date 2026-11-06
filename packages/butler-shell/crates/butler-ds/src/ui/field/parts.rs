//! The simple members of the Field family.
use gpui::{
    AnyElement, App, FontWeight, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::label::Label;
use crate::ui::layout::Space;
use crate::ui::separator::Separator;
use crate::ui::strut;

macro_rules! parent {
    ($name:ident) => {
        impl ParentElement for $name {
            fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
                self.children.extend(elements);
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

/// `fieldset`: its fields stacked by `--space-4`.
#[derive(IntoElement)]
pub struct FieldSet {
    children: Vec<AnyElement>,
}

impl FieldSet {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldSet);

impl RenderOnce for FieldSet {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        strut::flex_scope(
            true,
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .gap(ds.len(Length::Space4))
                .children(
                    self.children
                        .into_iter()
                        .map(|child| strut::flex_scope(true, child)),
                ),
        )
    }
}

/// `legend`: the set's title, medium weight, `--space-1` above its fields. React's `variant`
/// (`legend` or `label`) changes no style, so it is not a prop here.
#[derive(IntoElement)]
pub struct FieldLegend {
    children: Vec<AnyElement>,
}

impl FieldLegend {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldLegend);

impl RenderOnce for FieldLegend {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .mb(ds.len(Length::Space1))
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
            .children(self.children)
    }
}

/// `FieldGroup`: fields stacked by `--space-5`.
#[derive(IntoElement)]
pub struct FieldGroup {
    children: Vec<AnyElement>,
}

impl FieldGroup {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldGroup);

impl RenderOnce for FieldGroup {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        strut::flex_scope(
            true,
            div()
                .flex()
                .flex_col()
                .w_full()
                .gap(ds.len(Length::Space5))
                .children(
                    self.children
                        .into_iter()
                        .map(|child| strut::flex_scope(true, child)),
                ),
        )
    }
}

/// `FieldLabel`: a Label on the label line height, as wide as its text.
#[derive(IntoElement)]
pub struct FieldLabel {
    children: Vec<AnyElement>,
}

impl FieldLabel {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldLabel);

impl RenderOnce for FieldLabel {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        Label::new().in_field().children(self.children)
    }
}

/// `FieldTitle`: the name of a field that has no control to label.
#[derive(IntoElement)]
pub struct FieldTitle {
    children: Vec<AnyElement>,
}

impl FieldTitle {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldTitle);

impl RenderOnce for FieldTitle {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let el = div()
            .flex()
            .items_center()
            .gap(ds.len(Length::Space2))
            .text_size(ds.len(Length::FontSize3))
            .font_weight(FontWeight(ds.number(Number::FontWeightMedium)));
        let el = if strut::shrink_wrap(cx) {
            el.self_start()
        } else {
            el
        };
        el.children(self.children)
    }
}

/// `FieldDescription`: `--font-size-3` on the body line, secondary.
#[derive(IntoElement)]
pub struct FieldDescription {
    children: Vec<AnyElement>,
}

impl FieldDescription {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldDescription);

impl RenderOnce for FieldDescription {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeight))
            .text_color(ds.color(Color::TextSecondary))
            .children(self.children)
    }
}

/// `FieldError`: an alert in the danger colour, from children or a list of messages. Messages
/// are de-duplicated; one is plain text, more are a list. It draws nothing when empty.
#[derive(IntoElement)]
pub struct FieldError {
    messages: Vec<SharedString>,
    children: Vec<AnyElement>,
}

impl FieldError {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            children: Vec::new(),
        }
    }

    /// `errors`: the messages, repeated ones once.
    pub fn errors(mut self, messages: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        for message in messages.into_iter().map(Into::into) {
            if !self.messages.contains(&message) {
                self.messages.push(message);
            }
        }
        self
    }
}

parent!(FieldError);

impl RenderOnce for FieldError {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let body: Vec<AnyElement> = if !self.children.is_empty() {
            self.children
        } else if self.messages.len() == 1 {
            self.messages
                .into_iter()
                .map(IntoElement::into_any_element)
                .collect()
        } else if self.messages.is_empty() {
            return div().into_any_element();
        } else {
            vec![
                div()
                    .flex()
                    .flex_col()
                    .gap(ds.len(Length::SpaceXs))
                    .pl(ds.len(Length::SpaceLg))
                    .children(self.messages)
                    .into_any_element(),
            ]
        };
        div()
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeight))
            .text_color(ds.color(Color::Danger))
            .children(body)
            .into_any_element()
    }
}

/// `FieldSeparator`: a 20px band with a rule through it, and optional text on the rule.
#[derive(IntoElement)]
pub struct FieldSeparator {
    children: Vec<AnyElement>,
}

impl FieldSeparator {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

parent!(FieldSeparator);

/// The band's height (DS: Field.module.css:98).
const SEPARATOR_HEIGHT: f32 = 20.;

impl RenderOnce for FieldSeparator {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let rule = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .child(Separator::new().space(Space::Xs));
        let text = (!self.children.is_empty()).then(|| {
            div().relative().flex().justify_center().child(
                div()
                    .px(ds.len(Length::Space2))
                    .bg(ds.color(Color::Background))
                    .text_color(ds.color(Color::TextSecondary))
                    .children(self.children),
            )
        });
        div()
            .relative()
            .w_full()
            .h(px(SEPARATOR_HEIGHT))
            .my(-ds.len(Length::Space2))
            .text_size(ds.len(Length::FontSize3))
            .child(rule)
            .children(text)
    }
}
