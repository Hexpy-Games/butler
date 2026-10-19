//! Which canonical sources one recall's scope and time admit.

use crate::cognition::recall::{RecallProjectFilter, RecallRequest, RecallScope, RecallTimeBasis};
use butler_turn::conversation::ConversationSession;

#[derive(Clone, Copy)]
pub(in crate::cognition) struct RecallFilter<'a> {
    pub input: &'a RecallRequest,
    pub parse_date: &'a dyn Fn(&str) -> f64,
}

impl RecallFilter<'_> {
    /// The session exists, is not deleted and is inside the recall scope.
    pub(in crate::cognition) fn session_admitted(
        &self,
        session: Option<&ConversationSession>,
    ) -> bool {
        session.is_some_and(|session| {
            session.status != "deleted" && self.in_scope(&session.id, session.project_id.as_deref())
        })
    }

    fn in_scope(&self, session: &str, project: Option<&str>) -> bool {
        let input = self.input;
        if input.scope == RecallScope::CurrentSession && session != input.runtime.session_id {
            return false;
        }
        if input.scope == RecallScope::CurrentProject
            && project != input.runtime.project_id.as_deref()
        {
            return false;
        }
        if !input.session_ids.is_empty() && !input.session_ids.iter().any(|id| id == session) {
            return false;
        }
        if input.project_filter == RecallProjectFilter::Unassigned && project.is_some() {
            return false;
        }
        if input.project_filter == RecallProjectFilter::Selected
            && !project.is_some_and(|id| input.project_ids.iter().any(|project| project == id))
        {
            return false;
        }
        true
    }

    /// Inside the conversation-time window, when the recall has one.
    pub(in crate::cognition) fn time_contains(&self, created: &str) -> bool {
        let Some(time) = self
            .input
            .time
            .as_ref()
            .filter(|time| time.basis == RecallTimeBasis::Conversation)
        else {
            return true;
        };
        let value = (self.parse_date)(created);
        value >= (self.parse_date)(&time.from) && value < (self.parse_date)(&time.to)
    }

    /// A recovered message created after the recall's cutoff.
    pub(in crate::cognition) fn after_cutoff(&self, created: &str) -> bool {
        (self.parse_date)(created) > (self.parse_date)(&self.input.as_of)
    }

    /// Any turn message was observed by the cutoff and, for a
    /// conversation-time window, inside it.
    pub(in crate::cognition) fn turn_in_time<'t>(
        &self,
        created: impl IntoIterator<Item = &'t str>,
    ) -> bool {
        let observed = created
            .into_iter()
            .filter(|created| (self.parse_date)(created) <= (self.parse_date)(&self.input.as_of))
            .collect::<Vec<_>>();
        if observed.is_empty() {
            return false;
        }
        !self
            .input
            .time
            .as_ref()
            .is_some_and(|time| time.basis == RecallTimeBasis::Conversation)
            || observed.iter().any(|created| self.time_contains(created))
    }
}
