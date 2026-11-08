//! `LogStorage.tsx`: the log storage section, its meters and its two actions. The export
//! dialog is in [`super::export`].
use butler_ds::ui::blocks::progress_meter::{MeterTone, ProgressMeter};
use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{AnyElement, App, ClickEvent, Context, EventEmitter, ParentElement as _, Window};
use serde::Deserialize;

use super::copy::{self, Words};
use super::text::format_bytes;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};

/// `LogStoreUsage`
#[derive(Deserialize)]
struct Store {
    id: String,
    bytes: f64,
    limit_bytes: f64,
    retention_h: f64,
}

/// `LogStorageView`
#[derive(Deserialize)]
struct Usage {
    stores: Vec<Store>,
}

/// `{ agent_freed_bytes }` of DELETE /logs.
#[derive(Deserialize)]
struct Cleared {
    #[serde(default)]
    agent_freed_bytes: f64,
}

/// The logs were deleted (`onCleared`): the log list reads again.
pub(crate) struct LogStorageEvent;

/// The export dialog (`LogExportDialog`).
pub(super) struct ExportForm {
    pub(super) open: bool,
    /// The export period: an index into `settings.logs.periods`.
    pub(super) period: usize,
    pub(super) include_bodies: bool,
    pub(super) busy: bool,
}

/// `LogStorage`
pub(crate) struct LogStorage {
    ctx: SectionCtx,
    usage: Load<Usage>,
    pub(super) export: ExportForm,
    clearing: bool,
    /// The `logs-clear` and `logs-export` toasts, each replaced by the next of its kind.
    clear_toast: Option<ToastId>,
    pub(super) export_toast: Option<ToastId>,
}

impl EventEmitter<LogStorageEvent> for LogStorage {}

/// Shows `next` in the place of the last toast of its kind.
pub(super) fn announce(slot: &mut Option<ToastId>, next: Toast, cx: &mut App) {
    let next = match *slot {
        Some(id) => next.id(id),
        None => next,
    };
    *slot = Some(toast::show(cx, next));
}

/// 0 and 1 are the main stores (`app/main`, `agent/main`); 2 and 3 have a limit per source
/// (`debug`, `bodies`).
fn kind(id: &str) -> Option<usize> {
    let mut parts = id.split('/');
    let (source, name) = (parts.next()?, parts.next()?);
    match name {
        "main" => Some(usize::from(source != "app")),
        "debug" => Some(2),
        "bodies" => Some(3),
        _ => None,
    }
}

/// How full a store is, 0 to 1.
fn fill(store: &Store) -> f64 {
    if store.limit_bytes > 0. {
        store.bytes / store.limit_bytes
    } else {
        0.
    }
}

/// Each meter shows whichever source's store is fuller, with that store's own limit.
fn groups(stores: &[Store]) -> [Option<&Store>; 4] {
    let mut groups: [Option<&Store>; 4] = [None; 4];
    for store in stores {
        let Some(kind) = kind(&store.id) else {
            continue;
        };
        if groups[kind].is_none_or(|current| fill(store) > fill(current)) {
            groups[kind] = Some(store);
        }
    }
    groups
}

/// A week or more reads in days (14 days); shorter windows in hours.
fn retention(copy: &Words, hours: f64) -> String {
    if hours >= 168. && (hours % 24.).abs() < f64::EPSILON {
        copy.retention_days
            .replace("{days}", &(hours / 24.).to_string())
    } else {
        copy.retention_hours.replace("{hours}", &hours.to_string())
    }
}

/// `StoreMeter`
fn meter(copy: &Words, index: usize, store: &Store) -> ProgressMeter {
    #[expect(clippy::cast_possible_truncation, reason = "a percent")]
    let value = (fill(store) * 100.).min(100.) as f32;
    let meta = copy
        .store_meta
        .replace("{used}", &format_bytes(store.bytes))
        .replace("{limit}", &format_bytes(store.limit_bytes))
        .replace("{retention}", &retention(copy, store.retention_h));
    ProgressMeter::new(format!("logs-store-{index}"), value)
        .label(copy.stores[index])
        .tone(if value >= 90. {
            MeterTone::Warning
        } else {
            MeterTone::Default
        })
        .meta(meta)
}

impl LogStorage {
    pub(crate) fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut storage = Self {
            ctx,
            usage: Load::Loading,
            export: ExportForm {
                open: false,
                period: 1,
                include_bodies: false,
                busy: false,
            },
            clearing: false,
            clear_toast: None,
            export_toast: None,
        };
        storage.reload(cx);
        storage
    }

    /// GET /logs/storage
    pub(crate) fn reload(&mut self, cx: &mut Context<Self>) {
        self.usage = Load::Loading;
        fetch(
            cx,
            |client| async move { client.get_logs_storage().await },
            |this: &mut Self, result: Result<Usage, Error>, _| {
                this.usage = result.map_or(Load::Failed, Load::Ready);
            },
        );
    }

    /// `clearAll`, after the owner confirmed.
    fn clear(&mut self, cx: &mut Context<Self>) {
        self.clearing = true;
        cx.notify();
        fetch(
            cx,
            |client| async move { client.delete_logs().await },
            |this: &mut Self, result: Result<Cleared, Error>, cx| {
                let copy = copy::get(cx);
                this.clearing = false;
                let next = match result {
                    Ok(cleared) => {
                        this.reload(cx);
                        cx.emit(LogStorageEvent);
                        let size = format_bytes(cleared.agent_freed_bytes);
                        Toast::success(copy.cleared.replace("{size}", &size))
                    }
                    Err(_) => Toast::error(copy.clear_failed),
                };
                announce(&mut this.clear_toast, next, cx);
            },
        );
    }

    fn ask_clear(&mut self, cx: &mut Context<Self>) {
        let copy = copy::get(cx);
        let weak = cx.entity().downgrade();
        let request = Request::new(copy.clear_body)
            .title(copy.clear_title)
            .confirm_label(copy.delete)
            .destructive();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = weak.update(cx, LogStorage::clear);
            },
            cx,
        );
    }

    /// The meters, then `LogStorageActions`' two rows.
    fn rows(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let copy = copy::get(cx);
        let mut rows: Vec<AnyElement> = Vec::new();
        if let Load::Ready(usage) = &self.usage {
            let found = groups(&usage.stores);
            let meters = found.iter().enumerate();
            rows.extend(
                meters
                    .filter_map(|(index, store)| Some(meter(copy, index, (*store)?)))
                    .map(gpui::IntoElement::into_any_element),
            );
        }
        let export = Button::new("logs-export-open")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.export_menu)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.export.open = true;
                cx.notify();
            }));
        let clear = Button::new("logs-clear-open")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.clear_menu)
            .when(self.clearing, Button::disabled)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.ask_clear(cx)));
        let actions = [
            SettingsActionField::new(copy.export_title, copy.export_description, export)
                .setting_id("logs-export"),
            SettingsActionField::new(copy.clear_label, copy.clear_description, clear)
                .setting_id("logs-clear"),
        ];
        rows.extend(actions.map(gpui::IntoElement::into_any_element));
        rows.push(self.export_dialog(window, cx));
        rows
    }

    /// The `logs-storage` section.
    pub(crate) fn section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let copy = copy::get(cx);
        let state = self.usage.state(|_| false);
        let mut section =
            SettingsSection::new("logs-storage", SettingsSectionKind::Status, copy.storage)
                .state(state)
                .on_retry(cx.listener(|this, _, _, cx| this.reload(cx)));
        if state == SettingsSectionState::Ready {
            for row in self.rows(window, cx) {
                section = section.child(row);
            }
        }
        section
    }
}
