//! `useMemoryOperation`, `ChatMemoryBody` and `ChatMemoryActions`: the chat memory section,
//! with the cleanup that frees the space of unused old copies.
use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::blocks::surface_panel::{Elevation, SurfacePanel};
use butler_ds::ui::button::{self, Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::tooltip::Side;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, ParentElement as _};
use serde_json::{Value, json};

use super::copy::Words;
use super::facts::memory_facts;
use super::format::free_text;
use super::reset::{ResetKind, ResetState};
use super::types::{Receipt, newer};
use super::{MemoryPage, lang, later, with_reason};
use crate::ui::settings::state::{fetch, fetch_if};

/// The kinds of receipt the reset and consolidation flows own.
const OTHER_KINDS: [&str; 4] = ["automatic", "profile", "project_memory", "consolidation"];

#[derive(Default)]
pub(super) struct Cleanup {
    receipt: Option<Receipt>,
    starting: bool,
    polling: bool,
}

impl Cleanup {
    /// `busy`
    pub(super) fn busy(&self) -> bool {
        self.starting || self.receipt.as_ref().is_some_and(Receipt::running)
    }
}

impl MemoryPage {
    /// `accept`: a cleanup receipt from the inventory (silent), a start or a poll.
    pub(super) fn accept_cleanup(&mut self, next: Receipt, announce: bool, cx: &mut Context<Self>) {
        if next
            .kind
            .as_deref()
            .is_some_and(|kind| OTHER_KINDS.contains(&kind))
            || !newer(self.cleanup.receipt.as_ref(), &next)
        {
            return;
        }
        let (running, phase, bytes) = (next.running(), next.phase.clone(), next.bytes_reclaimed);
        self.cleanup.receipt = Some(next);
        if running {
            self.poll_cleanup(cx);
        } else if announce {
            let lang = lang(cx);
            let text = free_text(&phase, bytes, lang);
            let toast = match phase.as_str() {
                "complete" => Toast::success(text),
                "failed" => Toast::error(text),
                _ => Toast::message(text),
            };
            self.notify("memory-space", toast, cx);
            self.reload_summary(cx);
        }
    }

    /// Reads the running cleanup again after a [`super::POLL`] (React: the memory events).
    fn poll_cleanup(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .cleanup
            .receipt
            .as_ref()
            .filter(|receipt| receipt.running() && !self.cleanup.polling)
            .map(|receipt| receipt.operation_id.clone())
        else {
            return;
        };
        self.cleanup.polling = true;
        later(cx, move |_, cx| {
            fetch_if(
                cx,
                move |client| async move { client.get_memory_cleanup(&id).await },
                |this: &mut Self, result: Result<Receipt, Error>, cx| {
                    this.cleanup.polling = false;
                    let before = this.cleanup.receipt.clone();
                    if let Ok(next) = result {
                        this.accept_cleanup(next, true, cx);
                    }
                    this.poll_cleanup(cx);
                    this.cleanup.receipt != before
                },
            );
        });
    }

    /// `start`: POST /memory/cleanup.
    fn start_cleanup(&mut self, cx: &mut Context<Self>) {
        if self.cleanup.busy() {
            return;
        }
        self.cleanup.starting = true;
        let body = json!({
            "operation_id": uuid::Uuid::new_v4().to_string(),
            "inventory_revision": self.revision(),
        });
        fetch(
            cx,
            move |client| async move { client.create_memory_cleanup(&body).await },
            |this: &mut Self, result: Result<Receipt, Error>, cx| {
                this.cleanup.starting = false;
                match result {
                    Ok(receipt) => this.accept_cleanup(receipt, true, cx),
                    Err(_) => {
                        let text = free_text("failed", 0, lang(cx));
                        this.notify("memory-space", Toast::error(text), cx);
                        this.reload_summary(cx);
                    }
                }
            },
        );
    }

    /// `cancel`: DELETE /memory/cleanup/{id}.
    fn cancel_cleanup(&mut self, cx: &mut Context<Self>) {
        let Some(receipt) = &self.cleanup.receipt else {
            return;
        };
        let (id, bytes) = (receipt.operation_id.clone(), receipt.bytes_reclaimed);
        fetch(
            cx,
            move |client| async move { client.delete_memory_cleanup(&id).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                if result.is_err() {
                    let text = free_text("failed", bytes, lang(cx));
                    this.notify("memory-space", Toast::error(text), cx);
                }
            },
        );
    }

    /// `ChatMemoryActions`
    fn free_button(
        &self,
        copy: &Words,
        locked: bool,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let reclaimable = self
            .card("automatic")
            .and_then(|card| card.health.reclaimable_bytes);
        let busy = self.cleanup.busy();
        let reason = if locked {
            Some(copy.in_use)
        } else if reclaimable == Some(0) {
            Some(copy.nothing_to_free)
        } else {
            None
        };
        let mut free = Button::new("free-space-button")
            .size(ButtonSize::Sm)
            .variant(Variant::Outline)
            .text(copy.free_space);
        if busy {
            free = free.icon_start(Spinner::new("free-space-spinner").size(14.));
        }
        if busy || locked || !ready || reclaimable == Some(0) {
            free = free.disabled();
        }
        let free = free.on_click(cx.listener(|this, _, _, cx| this.start_cleanup(cx)));
        with_reason("free-space-tip", reason, Side::Top, free)
    }

    pub(super) fn chat_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let chat = self.card("automatic");
        let ready = self.summary_ready() && chat.is_some_and(|card| card.item_count.is_some());
        let reset_running = self.reset.kind() == Some(ResetKind::Chat);
        let locked = self.reset.kind().is_some() || self.consolidation.running();
        let mut section =
            SettingsSection::new("chat-memory", SettingsSectionKind::Form, copy.titles[2])
                .description(copy.descriptions[2])
                .state(self.card_state(chat))
                .empty_message(copy.unavailable)
                .on_retry(cx.listener(|this, _, _, cx| this.reload_summary(cx)));
        for field in self.recall_fields(copy, cx) {
            section = section.child(field);
        }
        let mut actions =
            button::container(ButtonSize::Sm).child(self.free_button(copy, locked, ready, cx));
        if self.cleanup.busy() && self.cleanup.receipt.is_some() {
            actions = actions.child(
                Button::new("free-space-cancel")
                    .size(ButtonSize::Sm)
                    .variant(Variant::Outline)
                    .text(crate::ui::i18n::settings::words(lang).cancel)
                    .on_click(cx.listener(|this, _, _, cx| this.cancel_cleanup(cx))),
            );
        }
        let mut free =
            SettingsActionField::new(copy.storage_label, copy.free_space_description, actions)
                .details(
                    SurfacePanel::new()
                        .elevation(Elevation::Subtle)
                        .child(memory_facts(chat, None, copy, lang)),
                )
                .setting_id("free-space");
        if let Some(receipt) = self
            .cleanup
            .receipt
            .as_ref()
            .filter(|receipt| receipt.running())
        {
            let text = if receipt.phase == "preparing" {
                copy.free_waiting.to_owned()
            } else {
                free_text("freeing", receipt.bytes_reclaimed, lang)
            };
            free = free.meta(Typo::caption(text).tone(Tone::Secondary));
        }
        let state = ResetState {
            running: reset_running,
            ready,
            empty: chat.is_some_and(|card| card.item_count == Some(0)),
        };
        let reset = self.reset_button("reset-chat", copy, ResetKind::Chat, state, cx);
        section.child(free).child(
            SettingsActionField::new(copy.reset_chat_label, copy.reset_chat_description, reset)
                .setting_id("reset-chat-memory"),
        )
    }
}
