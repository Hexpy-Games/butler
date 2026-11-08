//! The composer's decision state: the open chat's view, its queue and the plan instruction
//! attachment above the input.
use std::rc::Rc;

use gpui::{AnyElement, Context};

use super::{Composer, adjunct};
use crate::ui::decisions::{DecisionCtx, plan_instruction};
use crate::ui::source::wire::{QueuedMessageRecord, SessionView};

impl Composer {
    /// The open chat's view, read by the decision surfaces.
    pub(crate) fn set_decision_view(&mut self, view: Option<Rc<SessionView>>) {
        self.decision_view = view;
    }

    /// `ComposerInputSurface`'s attachment above the input: the plan instruction context with
    /// its placeholder. The question panel, collapsed or not, shows in the transcript.
    pub(super) fn decision_attachment(
        &mut self,
        cx: &mut Context<Self>,
    ) -> (Option<AnyElement>, Option<&'static str>) {
        let Some(view) = self.decision_view.clone() else {
            return (None, None);
        };
        let ctx = DecisionCtx { view: &view };
        let plan = plan_instruction(ctx, cx);
        let placeholder = plan.as_ref().map(|plan| plan.placeholder);
        let plan = plan.map(|p| adjunct::plan_instruction_attachment(&p.title, p.label, cx));
        (plan, placeholder)
    }

    /// The open chat's queued follow-ups.
    pub(crate) fn set_queue(&mut self, queue: Vec<QueuedMessageRecord>) {
        self.queue = queue;
    }
}
