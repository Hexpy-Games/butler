//! `CanonProposalProject`.
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, Entity, IntoElement as _, ParentElement as _, SharedString};

use super::{NEW_PROJECT, ProposalState};
use crate::ui::i18n::canon_proposal::CanonProposalCopy;
use crate::ui::source::wire::CanonProposalProjectOption;

/// `CanonProposalProject`: the project select and, for a new project, its name.
pub(super) fn project_field(
    proposal_id: &str,
    target: &str,
    name: &str,
    busy: bool,
    projects: &[CanonProposalProjectOption],
    state: &Entity<ProposalState>,
    copy: &CanonProposalCopy,
) -> AnyElement {
    let mut select = NativeSelect::new(SharedString::from(format!("{proposal_id}-project-select")))
        .stretch()
        .value(target.to_owned());
    for project in projects {
        select = select.option(project.id.clone(), project.display_name.clone());
    }
    select = select.option(NEW_PROJECT, copy.new_project);
    let on_select = state.clone();
    select = select.on_change(move |value, _, cx| {
        let value = value.to_owned();
        on_select.update(cx, |state, cx| {
            state.target = value;
            cx.notify();
        });
    });
    let mut field = Field::new(SharedString::from(format!("{proposal_id}-project")))
        .child(FieldLabel::new().child(SharedString::from(copy.project)));
    if busy {
        select = select.disabled();
    }
    field = field.child(select);
    if target == NEW_PROJECT {
        let on_name = state.clone();
        let mut input = Input::new(SharedString::from(format!("{proposal_id}-new-project")))
            .default_value(name.to_owned())
            .on_change(move |value, _, cx| {
                let value = value.to_owned();
                on_name.update(cx, |state, cx| {
                    state.name = value;
                    cx.notify();
                });
            });
        if busy {
            input = input.disabled();
        }
        field = field.child(input);
    }
    field.into_any_element()
}
