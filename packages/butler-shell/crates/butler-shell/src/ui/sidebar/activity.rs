//! SpaceActivity and useWorkStatus: activity is event driven with one coalesced read.
use super::Shell;
use crate::ui::{
    Icon,
    store::navigation::{SpaceRowData, space_activity},
};
use butler_ds::ui::{
    blocks::{nav_row::NavRow, nav_section::NavSectionHeading},
    context::Ds,
    icon::{IconSize, icon},
    icon_slot::{IconSlot, SlotSize},
    spinner::Spinner,
    typo::{Tone, Typo},
    unread_dot::UnreadDot,
};
use gpui::{AnyElement, Context, div, prelude::*};
impl Shell {
    pub(super) fn space_activity(
        &self,
        row: &SpaceRowData,
        nested: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        match row.session.as_ref().and_then(|s| space_activity(s, nested)) {
            Some("working") => {
                crate::ui::widgets::anchor(div(), &format!("sidebar-running-{}", row.node.entityId))
                    .child(
                        IconSlot::new()
                            .size(SlotSize::Sidebar)
                            .min_line()
                            .child(Spinner::new(gpui::SharedString::from(format!(
                                "working-{}",
                                row.node.key
                            )))),
                    )
                    .into_any_element()
            }
            Some(_) => IconSlot::new()
                .size(SlotSize::Sidebar)
                .min_line()
                .child(icon(Icon::CircleAlert, IconSize::Sm, Ds::get(cx)))
                .into_any_element(),
            None => {
                let active = self.store.selected().map(|c| c.session.0.as_ref());
                let unread =
                    self.store
                        .navigation
                        .unread(&row.node.entityId, self.sidebar.attended, active);
                UnreadDot::new(
                    gpui::SharedString::from(format!("unread-{}", row.node.key)),
                    self.copy("Unread", "읽지 않음"),
                )
                .present(unread)
                .into_any_element()
            }
        }
    }
    pub(super) fn space_work_status(&mut self, cx: &mut Context<Self>) -> AnyElement {
        self.space_work_status_list(self.store.navigation.work_status.clone(), cx)
    }
    fn space_work_status_list(
        &self,
        view: Option<crate::ui::source::wire::WorkStatusView>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let Some(view) = view.filter(|v| !v.items.is_empty()) else {
            return div().into_any_element();
        };
        let mut list = div()
            .flex()
            .flex_col()
            .gap(Ds::get(cx).len(butler_ds::tokens::Length::SpaceXs))
            .child(NavSectionHeading::new(
                self.copy("Work status", "작업 현황"),
            ));
        for item in view.items {
            let id = item.session_id.clone();
            let metadata = self.work_status_meta(&item);
            let summary = item
                .latest_report_summary
                .filter(|s| !s.is_empty())
                .unwrap_or(item.safe_summary);
            let mut nav = NavRow::new(
                gpui::SharedString::from(format!("work-{id}")),
                item.safe_title,
            )
            .glyph(Icon::MessageSquare)
            .on_click(cx.listener(move |s, _, w, cx| s.open_sidebar_session(&id, w, cx)));
            let summary = [summary, metadata]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ");
            if !summary.is_empty() {
                nav = nav
                    .multiline()
                    .meta(Typo::caption(summary).tone(Tone::Secondary));
            }
            list = list.child(nav);
        }
        list.into_any_element()
    }
    fn work_status_meta(&self, item: &crate::ui::source::wire::WorkStatusItemView) -> String {
        use crate::ui::source::wire::{WorkStatusItemViewStage, WorkStatusState};
        let state = match item.state {
            WorkStatusState::Running => self.copy("Running", "진행 중"),
            WorkStatusState::Completed => self.copy("Completed", "완료"),
            WorkStatusState::Attention => self.copy("Needs attention", "확인 필요"),
            WorkStatusState::OperationalAction => self.copy("Action needed", "조치 필요"),
            WorkStatusState::OperationalInterruption => self.copy("Interrupted", "중단됨"),
            WorkStatusState::Unknown => "",
        };
        let stage = match item.stage {
            Some(WorkStatusItemViewStage::Conception) => self.copy("Conception", "구상"),
            Some(WorkStatusItemViewStage::Planning) => self.copy("Planning", "계획"),
            Some(WorkStatusItemViewStage::Execution) => self.copy("Execution", "실행"),
            Some(WorkStatusItemViewStage::Review) => self.copy("Review", "검토"),
            Some(WorkStatusItemViewStage::Validation) => self.copy("Validation", "검증"),
            Some(WorkStatusItemViewStage::Reporting) => self.copy("Reporting", "보고"),
            _ => "",
        };
        let mut parts = vec![state.to_owned(), stage.to_owned()];
        if item.total_actions > 0 {
            parts.push(format!(
                "{}/{} {}",
                item.completed_actions,
                item.total_actions,
                self.copy("actions", "작업")
            ));
        }
        if item.effect_count > 0 {
            parts.push(format!(
                "{} {}",
                item.effect_count,
                self.copy("effects", "변경")
            ));
        }
        if let Some(artifacts) = &item.recent_artifacts {
            parts.push(artifacts.join(", "));
        }
        parts
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }
    pub(crate) fn sync_minute_clock(&mut self, cx: &mut Context<Self>) {
        let enabled =
            self.sidebar.tab == super::Tab::Recent && self.sidebar.attended && self.sidebar_open;
        if !enabled {
            self.sidebar.age_task = None;
            return;
        }
        if self.sidebar.age_task.is_some() {
            return;
        }
        self.sidebar.age_task = Some(cx.spawn(async move |weak, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(60))
                    .await;
                if weak.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
        }));
    }
    pub(super) fn load_work_status(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.work_in_flight {
            self.sidebar.work_dirty = true;
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        self.sidebar.work_in_flight = true;
        let epoch = self.store.epoch();
        let generation = self.sidebar.work_generation;
        Self::run(source.work_status(), cx, move |s, result, cx| {
            if s.store.epoch() != epoch || s.sidebar.work_generation != generation {
                return;
            }
            s.sidebar.work_in_flight = false;
            if let Ok(view) = result {
                s.store.navigation.work_status = Some(view);
                cx.notify();
            }
            if s.sidebar.work_dirty {
                s.schedule_work_status(cx);
            }
        });
    }
    pub(super) fn schedule_work_status(&mut self, cx: &mut Context<Self>) {
        self.sidebar.work_dirty = true;
        if self.sidebar.work_scheduled {
            return;
        }
        self.sidebar.work_scheduled = true;
        let generation = self.sidebar.work_generation;
        cx.spawn(async move |weak, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1500))
                .await;
            let _ = weak.update(cx, |s, cx| {
                if s.sidebar.work_generation != generation {
                    return;
                }
                s.sidebar.work_scheduled = false;
                s.sidebar.work_dirty = false;
                if s.sidebar.tab == super::Tab::Running {
                    s.load_work_status(cx);
                }
            });
        })
        .detach();
    }
}
