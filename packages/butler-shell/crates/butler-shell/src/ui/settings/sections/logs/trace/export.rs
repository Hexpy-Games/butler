//! `LogExportDialog.tsx` and `exportLogs` (`logsTransport.ts`): a period and whether to include
//! stored bodies, then the zip the agent builds is saved where the owner chooses.
//! As `logs-export.mjs` does, the app's own crash records are added to the zip as
//! `app/ui-crashes.json`, and the file is written beside the destination and renamed.
use std::io::Write as _;
use std::path::{Path, PathBuf};

use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::dialog::{Dialog, DialogContent};
use butler_ds::ui::layout::Justify;
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::toast::Toast;
use butler_platform::secure_fs;
use chrono::{SecondsFormat, TimeDelta, Utc};
use gpui::prelude::FluentBuilder as _;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Window};
use serde_json::json;

use super::copy;
use super::storage::{LogStorage, announce};
use crate::lifecycle::logs;
use crate::ui::source::agent::Jobs;

/// The hours each period reaches back (`PERIOD_HOURS`); `None` is all time.
const PERIOD_HOURS: [Option<i64>; 4] = [Some(1), Some(24), Some(24 * 7), None];

/// `periodSince`: the RFC 3339 start of a period, or nothing for all time.
fn since(period: usize) -> Option<String> {
    let hours = (*PERIOD_HOURS.get(period)?)?;
    let start = Utc::now() - TimeDelta::try_hours(hours)?;
    Some(start.to_rfc3339_opts(SecondsFormat::Millis, true))
}

impl LogStorage {
    /// The dialog, open while `exporting`; closing it is refused while the export runs.
    pub(super) fn export_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let copy = copy::get(cx);
        let weak = cx.entity().downgrade();
        let dialog = Dialog::new("logs-export-dialog", window, cx)
            .open(self.export.open)
            .on_open_change({
                let weak = weak.clone();
                move |open, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        if open || !this.export.busy {
                            this.export.open = open;
                            cx.notify();
                        }
                    });
                }
            });
        let range = copy.periods.iter().enumerate().fold(
            NativeSelect::new("logs-export-range").value(self.export.period.to_string()),
            |select, (index, label)| select.option(index.to_string(), *label),
        );
        let range = range.on_change({
            let weak = weak.clone();
            move |value, _, cx| {
                let Ok(period) = value.parse() else {
                    return;
                };
                let _ = weak.update(cx, |this, cx| {
                    this.export.period = period;
                    cx.notify();
                });
            }
        });
        let bodies = Switch::new("logs-export-bodies")
            .checked(self.export.include_bodies)
            .on_checked_change({
                let weak = weak.clone();
                move |checked, _, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.export.include_bodies = checked;
                        cx.notify();
                    });
                }
            });
        let submit = Button::new("logs-export-submit")
            .text(copy.export_action)
            .when(self.export.busy, Button::disabled)
            .on_click(move |_, _, cx| {
                let _ = weak.update(cx, super::storage::LogStorage::export);
            });
        let cancel = Button::new("logs-export-cancel")
            .variant(Variant::Outline)
            .text(copy.cancel)
            .on_click(dialog.closer().on_click());
        let form = DialogForm::new(copy.export_title)
            .child(
                SettingsField::new(copy.export_range)
                    .setting_id("logs-export-range-field")
                    .control(range),
            )
            .child(
                SettingsField::new(copy.include_bodies)
                    .setting_id("logs-export-bodies-field")
                    .control(bodies),
            )
            .footer(
                button::container(Size::Default)
                    .justify(Justify::End)
                    .child(cancel)
                    .child(submit),
            );
        dialog
            .content(DialogContent::new().child(form), window, cx)
            .into_any_element()
    }

    /// `submit`: asks where to save, builds the zip on the agent, writes it.
    fn export(&mut self, cx: &mut Context<Self>) {
        self.export.busy = true;
        cx.notify();
        let mut body = json!({ "include_bodies": self.export.include_bodies });
        if let (Some(since), Some(map)) = (since(self.export.period), body.as_object_mut()) {
            map.insert("since".to_owned(), since.into());
        }
        let directory = butler_platform::user_dirs::non_empty_home_dir()
            .map_or_else(PathBuf::new, |home| home.join("Downloads"));
        let data = crate::lifecycle::runtime(cx).map(|runtime| runtime.read(cx).data.clone());
        let ask = cx.prompt_for_new_path(&directory, Some("butler-logs.zip"));
        cx.spawn(async move |this, cx| {
            // `None`: the owner chose no file, which is neither a success nor a failure.
            let saved = match ask.await {
                Ok(Ok(Some(path))) => {
                    let zip = cx.update(|cx| {
                        Jobs::run(cx, move |client| async move {
                            client.export_logs(&body).await.ok().map(|file| file.bytes)
                        })
                    });
                    Some(match zip.await.flatten() {
                        Some(bytes) => {
                            cx.background_executor()
                                .spawn(async move { save(&path, bytes, data.as_deref()) })
                                .await
                        }
                        None => false,
                    })
                }
                _ => None,
            };
            let _ = this.update(cx, |this, cx| {
                let copy = copy::get(cx);
                this.export.busy = false;
                this.export.open = false;
                let toast = saved.map(|saved| {
                    if saved {
                        Toast::success(copy.exported)
                    } else {
                        Toast::error(copy.export_failed)
                    }
                });
                if let Some(toast) = toast {
                    announce(&mut this.export_toast, toast, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

/// `writeExport`: the agent's zip plus the crash records, written beside `destination` and
/// renamed, so a failed export leaves no partial zip. A zip that cannot take the extra entry
/// (zip64, damaged) is saved as it is.
fn save(destination: &Path, mut zip: Vec<u8>, data: Option<&Path>) -> bool {
    let crashes = data.map(logs::read_crashes).unwrap_or_default();
    if !crashes.is_empty()
        && let Ok(json) = serde_json::to_vec_pretty(&crashes)
    {
        logs::zip::append_entry(&mut zip, "app/ui-crashes.json", &json);
    }
    secure_fs::replace_private(destination, |file| file.write_all(&zip), |error| error).is_ok()
}
