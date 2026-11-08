//! The device pairing section (`SecurityPairingSection.tsx`, `usePairingSession.ts`). The code
//! lives only in this page while it is shown; it is never logged and is dropped when paired,
//! failed, or when remote access goes off.
use std::time::Duration;

use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField};
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _, Task, prelude::FluentBuilder as _};
use serde::Deserialize;

use super::SecurityPage;
use super::copy::{Words, words};
use crate::ui::settings::state::{fetch, fetch_if};

const POLL: Duration = Duration::from_secs(1);

/// `PairingCode` (no `Debug`: the digits must not reach a log).
#[derive(Deserialize)]
struct CodeView {
    id: String,
    code: String,
    expires_in: u64,
}

/// `PairingStatus`
#[derive(Deserialize)]
struct StatusView {
    id: String,
    status: String,
    invalidated_by: Option<String>,
    #[serde(default)]
    expires_in: u64,
}

#[derive(Default)]
pub(super) struct Pairing {
    code: Option<CodeView>,
    busy: bool,
    paired: bool,
    invalidated: bool,
    remaining: u64,
    /// Bumped whenever the code changes or the section unmounts; an answer for an older one is
    /// dropped (React's `cancelled`).
    epoch: u64,
    timer: Option<Task<()>>,
}

impl Pairing {
    /// The section unmounts: the code is dropped and pending answers are ignored.
    pub(super) fn reset(&mut self) {
        *self = Self {
            epoch: self.epoch + 1,
            ..Self::default()
        };
    }
}

impl SecurityPage {
    /// `issue`
    fn issue_pairing(&mut self, cx: &mut Context<Self>) {
        if self.pairing.busy {
            return;
        }
        self.pairing.busy = true;
        self.pairing.paired = false;
        self.pairing.invalidated = false;
        let epoch = self.pairing.epoch;
        fetch(
            cx,
            |client| async move { client.issue_pairing_code().await },
            move |this: &mut Self, result: Result<CodeView, Error>, cx| {
                if this.pairing.epoch != epoch {
                    return;
                }
                this.pairing.busy = false;
                match result {
                    Ok(code) => this.set_code(code, cx),
                    Err(_) => this.pairing_failed(cx),
                }
            },
        );
    }

    fn set_code(&mut self, code: CodeView, cx: &mut Context<Self>) {
        self.pairing.remaining = code.expires_in;
        self.pairing.code = Some(code);
        self.pairing.epoch += 1;
        self.schedule_poll(cx);
    }

    fn pairing_failed(&mut self, cx: &mut Context<Self>) {
        self.pairing.code = None;
        self.pairing.busy = false;
        self.pairing.timer = None;
        self.pairing.epoch += 1;
        let failed = words(Ds::get(cx).lang()).pairing_failed;
        toast::show(cx, Toast::error(failed));
    }

    /// The next status read in a second.
    fn schedule_poll(&mut self, cx: &mut Context<Self>) {
        let epoch = self.pairing.epoch;
        self.pairing.timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(POLL).await;
            let _ = this.update(cx, |this, cx| this.poll_pairing(epoch, cx));
        }));
    }

    /// `poll`: paired ends the session; an expired or invalidated code is replaced.
    fn poll_pairing(&mut self, epoch: u64, cx: &mut Context<Self>) {
        let Some(id) = self.pairing.code.as_ref().map(|code| code.id.clone()) else {
            return;
        };
        if self.pairing.epoch != epoch {
            return;
        }
        fetch_if(
            cx,
            |client| async move { client.get_pairing_status().await },
            move |this: &mut Self, result: Result<Option<StatusView>, Error>, cx| {
                if this.pairing.epoch != epoch {
                    return false;
                }
                match result {
                    Ok(Some(status)) if status.id == id && status.status == "paired" => {
                        this.pairing.code = None;
                        this.pairing.timer = None;
                        this.pairing.paired = true;
                        this.pairing.epoch += 1;
                        this.refresh_devices(cx);
                    }
                    Ok(Some(status)) if status.id == id && status.status == "active" => {
                        let changed = this.pairing.remaining != status.expires_in;
                        this.pairing.remaining = status.expires_in;
                        this.schedule_poll(cx);
                        return changed;
                    }
                    Ok(status) => {
                        let invalidated = status.is_some_and(|s| s.invalidated_by.is_some());
                        this.replace_code(epoch, invalidated, cx);
                    }
                    Err(_) => this.pairing_failed(cx),
                }
                true
            },
        );
    }

    /// The old code is hidden while its replacement is issued.
    fn replace_code(&mut self, epoch: u64, invalidated: bool, cx: &mut Context<Self>) {
        self.pairing.busy = true;
        fetch(
            cx,
            |client| async move { client.issue_pairing_code().await },
            move |this: &mut Self, result: Result<CodeView, Error>, cx| {
                if this.pairing.epoch != epoch {
                    return;
                }
                this.pairing.busy = false;
                match result {
                    Ok(code) => {
                        this.pairing.invalidated = invalidated;
                        this.set_code(code, cx);
                    }
                    Err(_) => this.pairing_failed(cx),
                }
            },
        );
    }

    /// `SecurityPairingSection`
    pub(super) fn pairing_section(&self, copy: &Words, cx: &mut Context<Self>) -> SettingsSection {
        let pairing = &self.pairing;
        let unavailable = self.busy || pairing.busy || pairing.code.is_some();
        let digits = if pairing.busy {
            None
        } else {
            pairing.code.as_ref().map(|code| code.code.as_str())
        };
        let mut column = Stack::new().gap(Space::Sm).cross(Cross::Start);
        if let Some(digits) = digits {
            let (head, tail) = digits.split_at_checked(4).unwrap_or((digits, ""));
            column = column.child(
                Stack::new()
                    .gap(Space::Xs)
                    .child(
                        Typo::metric_value(format!("{head} {tail}"))
                            .tabular()
                            .wrap(Wrap::Nowrap),
                    )
                    .child(
                        Typo::caption((copy.expires_in)(pairing.remaining)).tone(Tone::Secondary),
                    ),
            );
        }
        if pairing.invalidated {
            column = column.child(Typo::caption(copy.invalidated).tone(Tone::Secondary));
        }
        if pairing.paired {
            column = column.child(Typo::caption(copy.paired).tone(Tone::Success));
        }
        if digits.is_none() {
            let button = Button::new("pairing-issue")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(copy.pair_device)
                .when(unavailable, Button::disabled)
                .on_click(cx.listener(|this, _, _, cx| this.issue_pairing(cx)));
            let tip = if unavailable {
                copy.working
            } else {
                copy.pair_device
            };
            column = column.child(Tooltip::new("pairing-issue-tip").label(tip).child(button));
        }
        let field = SettingsField::new(copy.code)
            .setting_id("pairing-code")
            .control_width(ControlWidth::Full)
            .control(column);
        SettingsSection::new(
            "device-pairing",
            SettingsSectionKind::Form,
            copy.pair_device,
        )
        .holds_fields()
        .child(field)
    }
}
