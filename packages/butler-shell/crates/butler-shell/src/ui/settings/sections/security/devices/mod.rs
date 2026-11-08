//! The paired devices section (`SecurityDevicesSection.tsx`, `usePairedDevices.ts`).
use std::time::{SystemTime, UNIX_EPOCH};

use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _, SharedString, prelude::FluentBuilder as _};
use serde::Deserialize;
use serde_json::Value;

use super::SecurityPage;
use super::copy::{Words, words};
use crate::ui::Icon;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};

/// `PairedDevice`
#[derive(Deserialize)]
struct Device {
    id: String,
    name: String,
    ip: String,
    last_seen_at: u64,
}

pub(super) struct Devices {
    load: Load<Vec<Device>>,
    busy: bool,
    /// Bumped by each read and when the section unmounts; an older answer is dropped.
    revision: u64,
    started: bool,
}

impl Devices {
    pub(super) fn new() -> Self {
        Self {
            load: Load::Loading,
            busy: false,
            revision: 0,
            started: false,
        }
    }

    /// The section unmounts.
    pub(super) fn reset(&mut self) {
        *self = Self {
            revision: self.revision + 1,
            ..Self::new()
        };
    }

    /// The section has mounted and read the list.
    pub(super) fn started(&self) -> bool {
        self.started
    }
}

/// `lastSeen`: `Intl.RelativeTimeFormat` with `numeric: "auto"`.
fn last_seen(copy: &Words, seen: u64, now: u64) -> String {
    let elapsed = now.saturating_sub(seen);
    match elapsed {
        0..60 => copy.just_now.to_owned(),
        60..3_600 => (copy.minutes_ago)(elapsed / 60),
        3_600..86_400 => (copy.hours_ago)(elapsed / 3_600),
        86_400..172_800 => copy.yesterday.to_owned(),
        _ => (copy.days_ago)(elapsed / 86_400),
    }
}

impl SecurityPage {
    /// `refresh`: GET /security/devices.
    pub(super) fn refresh_devices(&mut self, cx: &mut Context<Self>) {
        self.devices.started = true;
        self.devices.revision += 1;
        let revision = self.devices.revision;
        fetch(
            cx,
            |client| async move { client.list_paired_devices().await },
            move |this: &mut Self, result: Result<Vec<Device>, Error>, _| {
                if this.devices.revision == revision {
                    this.devices.load = match result {
                        Ok(devices) => Load::Ready(devices),
                        Err(_) => Load::Failed,
                    };
                }
            },
        );
    }

    /// `revoke`: one device, or (no id) all of them after a confirmation.
    fn revoke_devices(&mut self, device: Option<String>, cx: &mut Context<Self>) {
        if self.devices.busy {
            return;
        }
        if device.is_some() {
            self.run_revoke(device, cx);
            return;
        }
        let copy = words(Ds::get(cx).lang());
        let request = Request::new(copy.revoke_all_confirm)
            .title(copy.revoke_all_title)
            .confirm_label(copy.revoke_all)
            .destructive();
        let page = cx.entity().downgrade();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = page.update(cx, |this, cx| this.run_revoke(None, cx));
            },
            cx,
        );
    }

    fn run_revoke(&mut self, device: Option<String>, cx: &mut Context<Self>) {
        self.devices.busy = true;
        fetch(
            cx,
            move |client| async move {
                match device {
                    Some(id) => client.revoke_paired_device(&id).await,
                    None => client.revoke_all_paired_devices().await,
                }
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.devices.busy = false;
                match result {
                    Ok(_) => this.refresh_devices(cx),
                    Err(_) => {
                        let failed = words(Ds::get(cx).lang()).revoke_failed;
                        toast::show(cx, Toast::error(failed));
                    }
                }
            },
        );
    }

    /// `SecurityDevicesSection`
    pub(super) fn devices_section(&self, copy: &Words, cx: &mut Context<Self>) -> SettingsSection {
        let devices = &self.devices;
        let unavailable = self.busy || devices.busy;
        let any = matches!(&devices.load, Load::Ready(list) if !list.is_empty());
        let tip = if unavailable {
            copy.working
        } else if any {
            copy.revoke_all
        } else {
            copy.no_devices
        };
        let revoke_all = Button::new("devices-revoke-all")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.revoke_all)
            .when(unavailable || !any, Button::disabled)
            .on_click(cx.listener(|this, _, _, cx| this.revoke_devices(None, cx)));
        let mut section =
            SettingsSection::new("paired-devices", SettingsSectionKind::List, copy.devices)
                .state(devices.load.state(std::vec::Vec::is_empty))
                .empty_message(copy.no_devices)
                .on_retry(cx.listener(|this, _, _, cx| this.refresh_devices(cx)))
                .actions(
                    Tooltip::new("devices-revoke-all-tip")
                        .label(tip)
                        .child(revoke_all),
                );
        if let Load::Ready(list) = &devices.load {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs());
            for device in list {
                section = section.child(device_row(device, now, unavailable, copy, cx));
            }
        }
        section
    }
}

fn device_row(
    device: &Device,
    now: u64,
    unavailable: bool,
    copy: &Words,
    cx: &mut Context<SecurityPage>,
) -> Stack {
    let label = (copy.revoke_device)(&device.name);
    let id = device.id.clone();
    let revoke = Button::new(SharedString::from(format!("device-revoke-{}", device.id)))
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.revoke)
        .when(unavailable, Button::disabled)
        .on_click(cx.listener(move |this, _, _, cx| this.revoke_devices(Some(id.clone()), cx)));
    let tip = if unavailable {
        copy.working.to_owned()
    } else {
        label
    };
    let row = ListRow::new(device.name.clone())
        .icon(icon(Icon::Monitor, IconSize::Md, Ds::get(cx)))
        .description(device.ip.clone())
        .meta(last_seen(copy, device.last_seen_at, now));
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .wrap(true)
        .child(Stack::new().grow().min_width(MinWidth::Zero).child(row))
        .child(
            Tooltip::new(SharedString::from(format!(
                "device-revoke-tip-{}",
                device.id
            )))
            .label(tip)
            .child(revoke),
        )
}
