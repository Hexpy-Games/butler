//! Unfinished subtask lines under a session row (`SpaceRowSubtasks`).
use super::Shell;
use crate::ui::Icon;
use butler_ds::ui::{
    blocks::nav_row::{NavRow, NavRowChildren},
    context::Ds,
    icon::{IconSize, icon},
    typo::{Tone, Typo},
};
use gpui::{AnyElement, Context, prelude::*};
impl Shell {
    pub(super) fn subtask_lines(
        &self,
        session: &crate::ui::source::wire::SessionSummary,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut children = NavRowChildren::new();
        for task in &session.subtasks {
            children = children.child(self.subtask_line(&session.id, task, cx));
        }
        children.into_any_element()
    }
    fn subtask_line(
        &self,
        parent_id: &str,
        task: &crate::ui::source::wire::SubtaskView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = task.session_id.clone();
        let parent = parent_id.to_owned();
        let mark = match task.state {
            crate::ui::source::wire::SubtaskState::Paused => {
                let relation = task.relation_id.clone();
                let weak = cx.entity().downgrade();
                butler_ds::ui::icon_button::IconButton::new(
                    gpui::SharedString::from(format!("resume-{id}")),
                    self.copy("Resume", "계속하기"),
                )
                .glyph(Icon::Play)
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |s, cx| {
                        s.mutate(
                            crate::ui::source::sidebar::Mutation::ResumeSubtask(
                                relation.clone(),
                                parent.clone(),
                            ),
                            cx,
                        );
                    });
                })
                .into_any_element()
            }
            crate::ui::source::wire::SubtaskState::NeedsApproval => {
                icon(Icon::CircleAlert, IconSize::Sm, Ds::get(cx)).into_any_element()
            }
            _ => Typo::caption(match (task.plan_completed, task.plan_total) {
                (Some(done), Some(total)) if total > 0 => {
                    format!("{}/{total}", done.max(0).saturating_add(1).min(total))
                }
                _ => String::new(),
            })
            .tone(Tone::Secondary)
            .into_any_element(),
        };
        NavRow::new(
            gpui::SharedString::from(format!("subtask-{id}")),
            task.title.clone(),
        )
        .reserve_icon()
        .actions(mark)
        .disabled()
        .into_any_element()
    }
}
