//! `useMemoryReset`, `MemoryResetButton` and the profile section: erasing chat memory, the
//! profile or one project's memory after a confirmation.
use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::blocks::surface_panel::{Elevation, SurfacePanel};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::tooltip::Side;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, ParentElement as _, SharedString};
use serde_json::json;

use super::copy::{Words, words};
use super::facts::memory_facts;
use super::format::{removed_chat, removed_profile, removed_project};
use super::types::{Receipt, newer};
use super::{MemoryPage, lang, later, with_reason};
use crate::ui::settings::confirm::{Detail, Request};
use crate::ui::settings::state::fetch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResetKind {
    Chat,
    Profile,
    Project,
}

impl ResetKind {
    fn from_wire(kind: &str) -> Option<Self> {
        match kind {
            "automatic" => Some(Self::Chat),
            "profile" => Some(Self::Profile),
            "project_memory" => Some(Self::Project),
            _ => None,
        }
    }
}

#[derive(Default)]
pub(super) struct Reset {
    receipt: Option<Receipt>,
    starting: Option<ResetKind>,
    polling: bool,
}

impl Reset {
    fn running(&self) -> bool {
        self.receipt.as_ref().is_some_and(Receipt::running)
    }

    /// `reset.kind`: the reset being started or running.
    pub(super) fn kind(&self) -> Option<ResetKind> {
        self.starting.or_else(|| {
            self.receipt
                .as_ref()
                .filter(|receipt| receipt.running())
                .and_then(|receipt| receipt.kind.as_deref())
                .and_then(ResetKind::from_wire)
        })
    }
}

/// The props of a `MemoryResetButton`; it is locked while another memory operation runs.
#[derive(Clone, Copy)]
pub(super) struct ResetState {
    pub(super) running: bool,
    pub(super) ready: bool,
    pub(super) empty: bool,
}

impl MemoryPage {
    /// `accept`: a reset receipt from the inventory (silent), a start or a poll.
    pub(super) fn accept_reset(&mut self, next: Receipt, announce: bool, cx: &mut Context<Self>) {
        let Some(kind) = next.kind.as_deref().and_then(ResetKind::from_wire) else {
            return;
        };
        if !newer(self.reset.receipt.as_ref(), &next) {
            return;
        }
        let (running, complete) = (next.running(), next.phase == "complete");
        self.reset.receipt = Some(next);
        if running {
            self.poll_reset(cx);
        } else if announce {
            let copy = words(lang(cx));
            let toast = match (complete, kind) {
                (false, _) => Toast::error(copy.reset_failed),
                (true, ResetKind::Profile) => Toast::success(copy.reset_profile_done),
                (true, ResetKind::Project) => Toast::success(copy.reset_project_done),
                (true, ResetKind::Chat) => Toast::success(copy.reset_chat_done),
            };
            self.notify("memory-reset", toast, cx);
            self.reload_summary(cx);
            self.reload_project(cx);
            if kind == ResetKind::Project {
                Self::reload_instructions(true, cx);
            }
        }
    }

    /// Reads the running reset again after a [`super::POLL`] (React: the memory events).
    fn poll_reset(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .reset
            .receipt
            .as_ref()
            .filter(|receipt| receipt.running() && !self.reset.polling)
            .map(|receipt| receipt.operation_id.clone())
        else {
            return;
        };
        self.reset.polling = true;
        later(cx, move |_, cx| {
            fetch(
                cx,
                move |client| async move { client.get_memory_reset(&id).await },
                |this: &mut Self, result: Result<Receipt, Error>, cx| {
                    this.reset.polling = false;
                    if let Ok(next) = result {
                        this.accept_reset(next, true, cx);
                    }
                    this.poll_reset(cx);
                },
            );
        });
    }

    /// The confirmation of a reset: what goes, what stays.
    fn reset_request(&self, kind: ResetKind, lang: Lang) -> Request {
        let copy = words(lang);
        let count = |value: Option<u64>| value.unwrap_or(0);
        let mut request = match kind {
            ResetKind::Project => {
                Request::new(copy.reset_project_body).title(copy.reset_project_title)
            }
            ResetKind::Profile => {
                Request::new(copy.reset_profile_body).title(copy.reset_profile_title)
            }
            ResetKind::Chat => Request::new(copy.reset_body).title(copy.reset_chat_title),
        };
        let (removed, kept) = match kind {
            ResetKind::Project => {
                let info = self.project_info();
                let name = self
                    .selected_project()
                    .map(|project| project.display_name.clone());
                request = request.detail(Detail {
                    label: Some(copy.project.into()),
                    text: name.map_or_else(|| copy.project.into(), SharedString::from),
                    caption: None,
                });
                let removed = removed_project(
                    count(info.and_then(|info| info.conversations)),
                    count(info.and_then(|info| info.instructions)),
                    lang,
                );
                (removed, copy.kept_project)
            }
            ResetKind::Profile => {
                let card = self.card("profile");
                let removed = removed_profile(
                    count(card.and_then(|card| card.item_count)),
                    count(card.and_then(|card| card.pending_count)),
                    lang,
                );
                (removed, copy.kept_profile)
            }
            ResetKind::Chat => {
                let items = count(self.card("automatic").and_then(|card| card.item_count));
                (removed_chat(items, lang), copy.kept_chat)
            }
        };
        request
            .confirm_label(copy.reset)
            .destructive()
            .note(copy.reset_note)
            .detail(Detail {
                label: Some(copy.removed.into()),
                text: removed.into(),
                caption: None,
            })
            .detail(Detail {
                label: Some(copy.kept.into()),
                text: kept.into(),
                caption: None,
            })
    }

    /// `start`: the confirmation, then [`Self::run_reset`].
    pub(super) fn ask_reset(&mut self, kind: ResetKind, cx: &mut Context<Self>) {
        if self.reset.starting.is_some() || self.reset.running() {
            return;
        }
        let request = self.reset_request(kind, lang(cx));
        let revision = self.revision();
        let project_id = self
            .selected_project()
            .map(|project| project.id.clone())
            .unwrap_or_default();
        let page = cx.weak_entity();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = page.update(cx, |this, cx| {
                    this.run_reset(kind, revision, project_id, cx);
                });
            },
            cx,
        );
    }

    /// POST /memory/reset/{chat-memory | profile | projects/{id}}
    fn run_reset(
        &mut self,
        kind: ResetKind,
        revision: u64,
        project_id: String,
        cx: &mut Context<Self>,
    ) {
        self.reset.starting = Some(kind);
        let body = json!({
            "operation_id": uuid::Uuid::new_v4().to_string(),
            "inventory_revision": revision,
        });
        fetch(
            cx,
            move |client| async move {
                match kind {
                    ResetKind::Project => client.reset_memory_project(&project_id, &body).await,
                    ResetKind::Profile => client.reset_memory_profile(&body).await,
                    ResetKind::Chat => client.reset_chat_memory(&body).await,
                }
            },
            |this: &mut Self, result: Result<Receipt, Error>, cx| {
                this.reset.starting = None;
                match result {
                    Ok(receipt) => this.accept_reset(receipt, true, cx),
                    Err(_) => {
                        let copy = words(lang(cx));
                        this.notify("memory-reset", Toast::error(copy.reset_failed), cx);
                        this.reload_summary(cx);
                    }
                }
            },
        );
    }

    /// `MemoryResetButton`
    pub(super) fn reset_button(
        &self,
        id: &'static str,
        copy: &Words,
        kind: ResetKind,
        state: ResetState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locked = self.shared_busy() && !state.running;
        let reason = if locked {
            Some(copy.in_use)
        } else if state.empty {
            Some(copy.nothing_to_reset)
        } else {
            None
        };
        let mut button = Button::new(SharedString::from(format!("{id}-button")))
            .size(ButtonSize::Sm)
            .variant(Variant::Outline)
            .text(copy.reset);
        if state.running {
            button = button
                .icon_start(Spinner::new(SharedString::from(format!("{id}-spinner"))).size(14.));
        }
        if state.running || locked || !state.ready || state.empty {
            button = button.aria_disabled();
        }
        let button = button.on_click(cx.listener(move |this, _, _, cx| this.ask_reset(kind, cx)));
        with_reason(id, reason, Side::Top, button)
    }

    pub(super) fn profile_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let profile = self.card("profile");
        let running = self.reset.kind() == Some(ResetKind::Profile);
        let items = profile.and_then(|card| card.item_count);
        let pending = profile.and_then(|card| card.pending_count);
        let state = ResetState {
            running,
            ready: self.summary_ready() && items.is_some() && pending.is_some(),
            empty: items == Some(0) && pending == Some(0),
        };
        let reset = self.reset_button("reset-profile", copy, ResetKind::Profile, state, cx);
        let mut field = SettingsActionField::new(
            copy.reset_profile_label,
            copy.reset_profile_description,
            reset,
        )
        .details(
            SurfacePanel::new()
                .elevation(Elevation::Subtle)
                .child(memory_facts(profile, None, copy, lang)),
        )
        .setting_id("reset-profile");
        if profile.and_then(|card| card.health.consent_on) == Some(false) {
            field = field.meta(Typo::caption(copy.profile_building_off).tone(Tone::Secondary));
        }
        SettingsSection::new("profile-memory", SettingsSectionKind::Form, copy.titles[4])
            .description(copy.descriptions[4])
            .state(self.card_state(profile))
            .empty_message(copy.unavailable)
            .on_retry(cx.listener(|this, _, _, cx| this.reload_summary(cx)))
            .child(field)
    }
}
