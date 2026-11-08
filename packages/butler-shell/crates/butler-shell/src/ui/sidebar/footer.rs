//! SidebarFooter, update progress and client-side SpaceSidebar paging.
use super::Shell;
use crate::ui::{
    Icon,
    source::{sidebar::Mutation, wire::UpdateProgressViewStage},
};
use butler_ds::ui::{
    blocks::{nav_row::NavRow, nav_section::sidebar_nav},
    button::Button,
    progress_ring::{ProgressRing, Size},
    typo::{Tone, Typo},
};
use gpui::{AnyElement, Context, SharedString, div, prelude::*};
impl Shell {
    pub(super) fn sidebar_footer(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mut footer = Vec::new();
        if let Some(progress) = self.sidebar.update.clone()
            && let Some(row) = self.sidebar_update_item(progress, cx)
        {
            footer.push(row);
        }
        footer.push(self.sidebar_settings_item(cx));
        sidebar_nav(footer, butler_ds::ui::context::Ds::get(cx))
    }
    /// `SidebarSettingsItem`: opens General.
    fn sidebar_settings_item(&self, cx: &Context<Self>) -> AnyElement {
        let row = NavRow::new("settings", self.theme.strings.settings)
            .glyph(Icon::Settings)
            .on_click(cx.listener(|s, _, window, cx| s.open_settings("general", window, cx)));
        crate::ui::widgets::anchor(div().w_full(), "sidebar-settings")
            .child(row)
            .into_any_element()
    }
    fn sidebar_update_item(
        &self,
        progress: crate::ui::source::wire::UpdateProgressView,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        let stage = progress.stage;
        if !matches!(
            stage,
            UpdateProgressViewStage::Idle | UpdateProgressViewStage::Completed
        ) && progress.error_code.as_deref() != Some("update_cancelled")
        {
            let percent = if stage == UpdateProgressViewStage::Downloading {
                progress
                    .bytes_total
                    .filter(|n| *n > 0)
                    .zip(progress.bytes_done)
                    .map(|(total, done)| {
                        let done = i128::from(done.max(0));
                        let total = i128::from(total);
                        let percent = ((done * 100 + total / 2) / total).min(100);
                        percent as f32 / 100.
                    })
            } else {
                None
            };
            let label = match stage {
                UpdateProgressViewStage::Downloading => self.copy("Downloading", "다운로드 중"),
                UpdateProgressViewStage::Ready => self.copy("Update ready", "업데이트 준비됨"),
                UpdateProgressViewStage::Failed => self.copy("Update failed", "업데이트 실패"),
                _ => self.copy("Updating", "업데이트 중"),
            };
            let leading = Self::update_icon(&stage, percent, cx);
            // `SidebarUpdateItem`: the row opens Updates.
            let mut row = NavRow::new("sidebar-update", label)
                .icon(leading)
                .on_click(cx.listener(|s, _, window, cx| s.open_settings("updates", window, cx)));
            if let Some(percent) = percent {
                row = row.badge(format!("{:.0}%", percent * 100.));
            }
            if stage == UpdateProgressViewStage::Ready {
                let component = match progress.component {
                    crate::ui::source::wire::UpdateComponentId::App => Some("app"),
                    crate::ui::source::wire::UpdateComponentId::Service => Some("service"),
                    crate::ui::source::wire::UpdateComponentId::Unknown => None,
                };
                if let Some(component) = component {
                    row = row.actions(
                        Button::new("sidebar-update-restart")
                            .text(self.copy("Restart", "다시 시작"))
                            .on_click(cx.listener(move |s, _, _, cx| {
                                cx.stop_propagation();
                                s.mutate(
                                    Mutation::ApplyUpdate(
                                        serde_json::json!({"component":component}),
                                    ),
                                    cx,
                                );
                            })),
                    );
                }
            }
            return Some(row.into_any_element());
        }
        None
    }
    fn update_icon(
        stage: &UpdateProgressViewStage,
        percent: Option<f32>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let mut ring = ProgressRing::new("sidebar-update-progress")
            .size(Size::Sidebar)
            .value(if *stage == UpdateProgressViewStage::Ready {
                1.
            } else {
                percent.unwrap_or(0.)
            });
        if percent.is_none() && *stage != UpdateProgressViewStage::Ready {
            ring = ring.indeterminate();
        }
        if *stage == UpdateProgressViewStage::Ready {
            ring = ring.tone(butler_ds::ui::progress_ring::Tone::Success);
        }
        if *stage == UpdateProgressViewStage::Failed {
            butler_ds::ui::icon::icon(
                Icon::CircleAlert,
                butler_ds::ui::icon::IconSize::Sm,
                butler_ds::ui::context::Ds::get(cx),
            )
            .into_any_element()
        } else {
            ring.into_any_element()
        }
    }
    pub(super) fn sidebar_session_load_more(
        &mut self,
        parent: Option<String>,
        remaining: usize,
        shown: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let label = format!("{} ({remaining})", self.theme.strings.show_more);
        let hover_parent = parent.clone();
        let row = NavRow::new(
            SharedString::from(format!("load-more-{parent:?}")),
            label.clone(),
        )
        .reserve_icon()
        .label_element(Typo::text(label).tone(Tone::Secondary))
        .on_click(cx.listener(move |s, _, _, cx| {
            match &parent {
                Some(key) => {
                    s.sidebar.branch_counts.insert(key.clone(), shown + 5);
                }
                None => s.sidebar.visible_count += 30,
            }
            cx.notify();
        }))
        .into_any_element();
        let Some(parent) = hover_parent else {
            return row;
        };
        let weak = cx.entity().downgrade();
        div()
            .id(SharedString::from(format!("load-more-frame-{parent}")))
            .on_drag_move::<super::SpaceDragPayload>(move |event, _, cx| {
                if !event.bounds.contains(&event.event.position) {
                    return;
                }
                cx.stop_propagation();
                let _ = weak.update(cx, |s, cx| {
                    if s.sidebar.drag_source.is_some() {
                        let count = s.sidebar.branch_counts.entry(parent.clone()).or_insert(5);
                        *count = (*count + 5).min(shown + remaining);
                        cx.notify();
                    }
                });
            })
            .child(row)
            .into_any_element()
    }
}
