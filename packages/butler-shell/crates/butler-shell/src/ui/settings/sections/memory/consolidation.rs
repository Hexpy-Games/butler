//! `useConsolidation` and `ConsolidationFields`: when Butler tidies its memory, running it now,
//! and the last run. The model that consolidates is [`super::fields`].
use std::collections::HashSet;

use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::Inline;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::time_picker::TimePicker;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::tooltip::Side;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _};
use serde_json::json;

use super::copy::{Words, words};
use super::format::{consolidation_time, last_run};
use super::types::{ConsolidationReceipt, ConsolidationStatus, MemorySettings};
use super::{MemoryPage, lang, later, with_reason};
use crate::ui::Icon;
use crate::ui::settings::Save;
use crate::ui::settings::state::fetch;

#[derive(Default)]
pub(super) struct Consolidation {
    status: Option<ConsolidationStatus>,
    active: Option<ConsolidationReceipt>,
    starting: bool,
    /// Another process holds the consolidation (409 on start).
    lease_busy: bool,
    /// The operation ids this page started; only these announce their end.
    owned: HashSet<String>,
    polling: bool,
}

impl Consolidation {
    /// `running`
    pub(super) fn running(&self) -> bool {
        self.starting || self.active.is_some()
    }
}

impl MemoryPage {
    /// `reload`: GET /memory/consolidation.
    pub(super) fn reload_consolidation(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_memory_consolidation().await },
            |this: &mut Self, result: Result<ConsolidationStatus, Error>, cx| {
                this.consolidation.polling = false;
                if let Ok(next) = result {
                    this.consolidation.lease_busy = false;
                    match next.active.clone() {
                        Some(active) => this.accept_consolidation(active, cx),
                        None => {
                            // The run ended while the page was not told: read its outcome.
                            let ok = next
                                .last_run
                                .as_ref()
                                .is_none_or(|run| run.status != "error");
                            if let Some(ended) = this.consolidation.active.take() {
                                this.finish_consolidation(&ended.operation_id, ok, cx);
                            }
                        }
                    }
                    this.consolidation.status = Some(next);
                }
                this.poll_consolidation(cx);
            },
        );
    }

    /// Reads the status again while a run is in progress or the lease is held elsewhere (React:
    /// the memory events).
    fn poll_consolidation(&mut self, cx: &mut Context<Self>) {
        let consolidation = &mut self.consolidation;
        if consolidation.polling || (consolidation.active.is_none() && !consolidation.lease_busy) {
            return;
        }
        consolidation.polling = true;
        later(cx, |_, cx| super::MemoryPage::reload_consolidation(cx));
    }

    fn accept_consolidation(&mut self, next: ConsolidationReceipt, cx: &mut Context<Self>) {
        if next.phase == "running" {
            self.consolidation.active = Some(next);
        } else {
            self.consolidation.active = None;
            self.finish_consolidation(&next.operation_id, next.phase == "complete", cx);
        }
    }

    fn finish_consolidation(&mut self, operation_id: &str, ok: bool, cx: &mut Context<Self>) {
        if ok {
            Self::reload_patterns(cx);
        }
        if self.consolidation.owned.remove(operation_id) {
            let copy = words(lang(cx));
            let toast = if ok {
                Toast::success(copy.consolidation_done)
            } else {
                Toast::error(copy.consolidation_failed)
            };
            self.notify("memory-consolidation", toast, cx);
        }
    }

    /// `start`: POST /memory/consolidation.
    fn start_consolidation(&mut self, cx: &mut Context<Self>) {
        let consolidation = &mut self.consolidation;
        if consolidation.running() || consolidation.lease_busy {
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        consolidation.owned.insert(id.clone());
        consolidation.starting = true;
        let body = json!({ "operation_id": id });
        fetch(
            cx,
            move |client| async move { client.create_memory_consolidation(&body).await },
            move |this: &mut Self, result: Result<ConsolidationReceipt, Error>, cx| {
                this.consolidation.starting = false;
                match result {
                    Ok(receipt) => {
                        if receipt.operation_id != id {
                            this.consolidation.owned.remove(&id);
                        }
                        this.accept_consolidation(receipt, cx);
                        Self::reload_consolidation(cx);
                    }
                    Err(error) => {
                        this.consolidation.owned.remove(&id);
                        if matches!(error, Error::Http(409)) {
                            this.consolidation.lease_busy = true;
                            this.poll_consolidation(cx);
                        } else {
                            let copy = words(lang(cx));
                            this.notify(
                                "memory-consolidation",
                                Toast::error(copy.consolidation_failed),
                                cx,
                            );
                        }
                    }
                }
            },
        );
    }

    /// `LastRun`
    fn last_run_line(&self, copy: &Words, lang: Lang, cx: &gpui::App) -> AnyElement {
        let last = self
            .consolidation
            .status
            .as_ref()
            .and_then(|status| status.last_run.as_ref());
        let failed = last.is_some_and(|run| run.status == "error");
        let text = match last {
            Some(run) => last_run(&consolidation_time(&run.at, copy, lang), failed, lang),
            None => copy.never_run.to_owned(),
        };
        if !failed {
            return Typo::caption(text).tone(Tone::Secondary).into_any_element();
        }
        Inline::new()
            .wrap(false)
            .child(IconSlot::new().size(SlotSize::Sm).min_line().child(icon(
                Icon::AlertCircle,
                IconSize::Sm,
                Ds::get(cx),
            )))
            .child(Typo::caption(text).tone(Tone::Danger))
            .into_any_element()
    }

    /// `ConsolidationRunButton`
    fn run_button(&self, copy: &Words, locked: bool, cx: &mut Context<Self>) -> AnyElement {
        let running = self.consolidation.running();
        let mut button = Button::new("consolidation-run-button")
            .size(ButtonSize::Sm)
            .variant(Variant::Outline)
            .text(if running { copy.running } else { copy.run_now });
        if running {
            button = button.icon_start(Spinner::new("consolidation-run-spinner").size(14.));
        }
        if running || locked || self.consolidation.status.is_none() {
            button = button.disabled();
        }
        let button = button.on_click(cx.listener(|this, _, _, cx| this.start_consolidation(cx)));
        let reason = (locked && !running).then_some(copy.in_use);
        with_reason("consolidation-run-tip", reason, Side::Right, button)
    }

    pub(super) fn cleanup_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let settings = self.ctx.state.read(cx).slice::<MemorySettings>();
        let disabled = settings.is_none() || self.ctx.state.read(cx).saving();
        let time = settings
            .as_ref()
            .and_then(|settings| settings.consolidation_time.clone())
            .or_else(|| {
                self.consolidation
                    .status
                    .as_ref()
                    .and_then(|status| status.time_of_day.clone())
            })
            .unwrap_or_else(|| "04:00".to_owned());
        let ctx = self.ctx.clone();
        let picker = TimePicker::new("consolidation-time-picker", time, copy.pick_time)
            .locale(lang)
            .disabled(disabled)
            .on_value_change(move |value, _, cx| {
                ctx.save(
                    json!({ "consolidation_time": value.to_string() }),
                    Save::default(),
                    cx,
                );
            });
        let locked =
            self.cleanup.busy() || self.reset.kind().is_some() || self.consolidation.lease_busy;
        let run = SettingsActionField::new(
            copy.run_now_label,
            copy.run_now_description,
            self.run_button(copy, locked, cx),
        )
        .meta(self.last_run_line(copy, lang, cx))
        .setting_id("consolidation-run");
        let mut section =
            SettingsSection::new("memory-cleanup", SettingsSectionKind::Form, copy.titles[3])
                .description(copy.descriptions[3])
                .child(
                    SettingsField::new(copy.consolidation_time)
                        .description(copy.consolidation_time_description)
                        .control(picker)
                        .setting_id("consolidation-time"),
                )
                .child(run);
        for field in self.consolidation_model_fields(copy, lang, cx) {
            section = section.child(field);
        }
        section
    }
}
