//! DS NavRowChildren (NavRowChildren.tsx): rows nested under the NavRow just before, joined by a
//! 1px guide line centred on the parent's icon column (the density's row inset plus half its
//! icon size), so the line follows the density.
use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div, px};

use super::metrics::{density_of, metrics};
use crate::tokens::{Color, Density};
use crate::ui::context::Ds;

#[derive(IntoElement)]
pub struct NavRowChildren {
    density: Option<Density>,
    children: Vec<AnyElement>,
}

impl NavRowChildren {
    pub fn new() -> Self {
        Self {
            density: None,
            children: Vec::new(),
        }
    }

    /// Density override; omit inside a SidebarShell to follow the shell's, as NavRow does.
    pub fn density(mut self, density: Density) -> Self {
        self.density = Some(density);
        self
    }
}

impl Default for NavRowChildren {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for NavRowChildren {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for NavRowChildren {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let m = metrics(ds, density_of(ds, self.density, cx));
        let guide = m.padding + m.icon / 2. - 0.5; // DS: NavRow.module.css:287
        div()
            .relative()
            .flex()
            .flex_col()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(guide))
                    .w(px(1.))
                    .bg(ds.color(Color::Line)),
            )
            .children(self.children)
    }
}
