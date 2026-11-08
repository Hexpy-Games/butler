//! DS DialogForm (DialogForm.tsx / DialogForm.module.css): the body of a dialog task. A title and
//! optional description, the fields, and a footer of actions right-aligned with the primary last.
//! The title and description are `DialogTitle` / `DialogDescription`, which keep the close
//! button's room free inside a `DialogContent` and are plain flow text outside one.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _, Window, div,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::dialog::{DialogDescription, DialogTitle};
use crate::ui::layout::{Space, Stack};

#[derive(IntoElement)]
pub struct DialogForm {
    title: SharedString,
    description: Option<SharedString>,
    footer: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl DialogForm {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            footer: None,
            children: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The actions (a `button::container(..).justify(End)`, cancel first, primary last).
    pub fn footer(mut self, footer: impl IntoElement) -> Self {
        self.footer = Some(footer.into_any_element());
        self
    }
}

impl ParentElement for DialogForm {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for DialogForm {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let head = Stack::new()
            .gap(Space::Xs)
            .child(DialogTitle::new(self.title))
            .children(self.description.map(DialogDescription::new));
        let footer = self.footer.map(|footer| {
            div()
                .flex()
                .flex_wrap()
                .justify_end()
                .gap(ds.len(Length::SpaceSm))
                .child(footer)
        });
        div()
            .flex()
            .flex_col()
            .w_full()
            .gap(ds.len(Length::SpaceLg))
            .text_color(ds.color(Color::TextPrimary))
            .child(head)
            .child(Stack::new().gap(Space::Md).children(self.children))
            .children(footer)
    }
}
