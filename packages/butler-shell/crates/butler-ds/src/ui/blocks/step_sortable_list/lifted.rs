//! The lifted copy (`StepSortableLifted.tsx`): the dragged row itself at its size, on the opaque
//! raised surface, with the drag shadow, hanging `--space-3xl` below the pointer so the target,
//! its ring and the gap line stay in view. It is the view gpui draws at the pointer for the
//! drag; its row context carries `outcome`, so a caption can say what the drop does. Not
//! reproduced: the `lift-in` shadow fade.
use std::rc::Rc;

use gpui::{
    AnyElement, Context, ElementId, IntoElement as _, ParentElement as _, Pixels, Point, Render,
    SharedString, Styled as _, Window, div,
};

use super::deck::{DeckArgs, deck};
use super::grip::Grip;
use super::model::{StepSortableTargetKind, locate_item};
use super::row::{RowArgs, row};
use super::session::{Hub, Mode, step_key};
use super::{Env, RenderItem, StepSortableOutcome, StepSortableRowContext, sub};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::card::Card;
use crate::ui::context::Ds;
use crate::ui::convert;

pub(super) struct Lifted {
    pub hub: Rc<Hub>,
    pub list: ElementId,
    pub render_item: RenderItem,
    pub drag_id: SharedString,
    /// Where in the dragged element the pointer took hold.
    pub offset: Point<Pixels>,
}

impl Render for Lifted {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let id = sub(&self.list, "lifted", &self.drag_id);
        let env = Env::from_hub(&id, &self.hub, &self.render_item);
        let view = env.view.clone();
        let carried = view.mode == Some(Mode::Pointer)
            && view.active_id.as_ref() == Some(&self.drag_id);
        let chains = self.hub.borrow().chains.clone();
        let at = view.item_ids.first().and_then(|first| locate_item(&chains, first));
        let (Some(at), true) = (at, carried) else {
            return div().into_any_element();
        };
        let chain = &chains[at.chain_index];
        let step = &chain.steps[at.step_index];
        let item = &step[at.item_index];
        let outcome = view.target.as_ref().map(|target| {
            if target.kind == StepSortableTargetKind::Join {
                StepSortableOutcome::Join
            } else {
                StepSortableOutcome::NewStep
            }
        });
        let ctx = StepSortableRowContext {
            chain_id: chain.id.clone(),
            step_index: at.step_index,
            step_number: at.step_index + 1,
            count: step.len(),
            expanded: false,
            lifted: true,
            outcome,
        };
        let whole = view.item_ids.len() == step.len() && step.len() > 1;
        let inner: AnyElement = if whole {
            let args = DeckArgs { step, expanded: false, interactive: false, base: ctx };
            deck(&env, &args, window, cx)
        } else {
            let grip = Grip {
                drag_id: SharedString::default(),
                label: SharedString::default(),
                movable: true,
            };
            let ctx = StepSortableRowContext { expanded: step.len() > 1, ..ctx };
            let content = row(
                &env,
                RowArgs { item, ctx, grip: Some(grip), marker: true, dim: false },
                window,
                cx,
            );
            let mut card = Card::new(sub(&id, "card", &item.id));
            if item.running {
                card = card.running();
            }
            card.child(content).into_any_element()
        };
        let width = self.hub.borrow().boxes.get(&step_key(&chain.id, at.step_index)).map(|b| b.size.width);
        let (gap, radius, fill, shadow) = {
            let ds = Ds::get(cx);
            (
                ds.len(Length::Space3xl),
                ds.len(Length::RadiusControl),
                ds.color(Color::ColorSurfaceRaisedOpaque),
                convert::box_shadows(ds.tokens().shadow(Shadow::ShadowDragLift), ds.tokens()),
            )
        };
        let mut surface = div().rounded(radius).bg(fill).shadow(shadow).child(inner);
        if let Some(width) = width {
            surface = surface.w(width);
        }
        div().pt(self.offset.y + gap).child(surface).into_any_element()
    }
}
