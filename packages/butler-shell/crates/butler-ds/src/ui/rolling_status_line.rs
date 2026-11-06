//! DS RollingStatusLine (RollingStatusLine.tsx / RollingStatusLine.module.css): the one-line
//! slot of a turn's status, a body line tall. Its content is clipped; a long line truncates
//! with an ellipsis (give the text `Typo::truncate`).
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div};

use super::context::Ds;
use crate::tokens::Length;

#[derive(IntoElement)]
pub struct RollingStatusLine {
    children: Vec<AnyElement>,
}

impl RollingStatusLine {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for RollingStatusLine {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for RollingStatusLine {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for RollingStatusLine {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        // `.content > * { min-width: 0; overflow: hidden }`
        let content = div().w_full().min_w_0().overflow_hidden().children(
            self.children
                .into_iter()
                .map(|child| div().min_w_0().overflow_hidden().child(child)),
        );
        div()
            .flex()
            .h(ds.len(Length::TypoBodyLineHeight))
            .min_w_0()
            .items_center()
            .overflow_hidden()
            .child(content)
    }
}
