//! The lifted copy of a pointer-dragged card (`.overlay`): the card on the opaque raised
//! surface with the drag shadow, drawn at the pointer by gpui. The card stays home as a faint
//! placeholder (`KanbanCard`). Not reproduced (`ANIM-MIGRATE`): the lift spring and the settle
//! into the new place; `--motion-scale-lift` is 1.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, IntoElement, ParentElement as _, Pixels, Point, Render, SharedString,
    Styled as _, Window, div,
};

use crate::tokens::{Color, Length, Shadow};
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::typo::Typo;

/// What the lifted copy shows in place of the card's own children, which gpui cannot draw twice.
pub(super) type Preview = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

pub(super) struct Lifted {
    pub label: SharedString,
    pub preview: Option<Preview>,
    pub width: Option<Pixels>,
    /// Where the pointer grabbed the card: the view is drawn at the pointer, so it shifts back.
    pub offset: Point<Pixels>,
}

impl Render for Lifted {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // ANIM-MIGRATE(the overlay lifts with a spring on pick-up and settles into the new place or back home on a drop)
        let content = match &self.preview {
            Some(preview) => preview(window, cx),
            None => Typo::body(self.label.clone())
                .line_clamp(2)
                .into_any_element(),
        };
        let ds = Ds::get(cx);
        let radius = ds.len(Length::RadiusControl);
        let shadow = convert::box_shadows(ds.tokens().shadow(Shadow::ShadowDragLift), ds.tokens());
        let mut surface = div()
            .rounded(radius)
            .bg(ds.color(Color::ColorSurfaceRaisedOpaque))
            .shadow(shadow)
            .child(
                Card::new("kanban-lifted")
                    .padding(CardPadding::Md)
                    .child(content),
            );
        if let Some(width) = self.width {
            surface = surface.w(width);
        }
        div()
            .relative()
            .left(-self.offset.x)
            .top(-self.offset.y)
            .child(surface)
    }
}
