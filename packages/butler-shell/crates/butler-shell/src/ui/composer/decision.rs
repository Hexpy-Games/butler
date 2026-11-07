//! The composer's decision surfaces: the open chat's view, its queue and the attachment above
//! the input.
use std::rc::Rc;

use gpui::{AnyElement, Context, Window, div, prelude::*};

use super::{Composer, adjunct};
use crate::ui::decisions::{DecisionCtx, plan_instruction, question_attachment};
use crate::ui::source::wire::{QueuedMessageRecord, SessionView};

impl Composer {
    /// The open chat's view, read by the decision surfaces.
    pub(crate) fn set_decision_view(&mut self, view: Option<Rc<SessionView>>) {
        self.decision_view = view;
    }

    /// `ComposerInputSurface`'s attachment above the input: the question context, then the plan
    /// instruction context with its placeholder.
    pub(super) fn decision_attachment(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Option<AnyElement>, Option<&'static str>) {
        let Some(view) = self.decision_view.clone() else {
            return (None, None);
        };
        let ctx = DecisionCtx { view: &view };
        let plan = plan_instruction(ctx, cx);
        let placeholder = plan.as_ref().map(|plan| plan.placeholder);
        let plan = plan.map(|p| adjunct::plan_instruction_attachment(&p.title, p.label, cx));
        let parts: Vec<AnyElement> = question_attachment(ctx, window, cx)
            .into_iter()
            .chain(plan)
            .collect();
        let attachment =
            (!parts.is_empty()).then(|| div().flex().flex_col().children(parts).into_any_element());
        (attachment, placeholder)
    }

    /// The open chat's queued follow-ups.
    pub(crate) fn set_queue(&mut self, queue: Vec<QueuedMessageRecord>) {
        self.queue = queue;
    }
}
