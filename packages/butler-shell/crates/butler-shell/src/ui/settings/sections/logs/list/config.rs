//! 기록 (`LogLevelFields.tsx`, `LogCategoryLevels.tsx`, `useLogConfig.ts`): the preset, the
//! full-logging lease and per-category overrides.
use std::collections::BTreeMap;
use std::time::Duration;

use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::blocks::settings_field::{ControlWidth, SettingsField};
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Inline, Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::toast::Toast;
use butler_shell_client::Error;
use chrono::{DateTime, Utc};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _};
use serde::Deserialize;

use super::api::{self, LogConfig, PRESETS, SEVERITIES};
use super::copy::LogsCopy;
use super::format::format_bytes;
use super::{LogList, show};
use crate::ui::i18n::settings::words;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::fetch;

/// How often the minutes left of a full-logging lease are read again.
const LEASE_TICK: Duration = Duration::from_secs(15);

/// `settings.log_full`, the shared settings the fields read.
#[derive(Deserialize)]
struct Slice {
    log_full: Option<LogFull>,
}

#[derive(Deserialize)]
struct LogFull {
    previous: Option<String>,
}

/// Turning full logging off returns to the preset it replaced.
fn previous_preset(previous: Option<&str>) -> &'static str {
    PRESETS
        .iter()
        .copied()
        .find(|preset| Some(*preset) == previous && *preset != "full")
        .unwrap_or("standard")
}

impl LogList {
    /// Reads the config; the section keeps what it shows while a re-read is under way.
    pub(super) fn load_config(&mut self, cx: &mut Context<Self>) {
        self.level.failed = false;
        fetch(
            cx,
            |client| async move { client.get_logs_config().await },
            |this: &mut Self, result: Result<LogConfig, Error>, cx| match result {
                Ok(config) => this.set_config(config, cx),
                Err(_) => this.level.failed = true,
            },
        );
    }

    fn set_config(&mut self, config: LogConfig, cx: &mut Context<Self>) {
        let level =
            |config: Option<&LogConfig>| config.map(|config| config.effective.level.clone());
        // A new level can free stores; read their sizes again (`storageRevision`).
        if level(self.config.as_ref()) != level(Some(&config)) {
            self.storage
                .update(cx, super::super::trace::LogStorage::reload);
        }
        self.config = Some(config);
        let running_minutes = self.minutes_left();
        let running = running_minutes.is_some_and(|minutes| minutes > 0);
        self.lease = running.then(|| {
            cx.spawn(async move |this, cx| {
                let mut shown = running_minutes;
                loop {
                    butler_ds::ui::motion::sleep(cx.background_executor(), LEASE_TICK).await;
                    let Ok(ended) = this.update(cx, |list, cx| {
                        let left = list.minutes_left();
                        if left != shown {
                            shown = left;
                            cx.notify();
                        }
                        left == Some(0)
                    }) else {
                        return;
                    };
                    if ended {
                        // The agent ends the lease itself; read the level it fell back to.
                        let _ = this.update(cx, super::LogList::load_config);
                        return;
                    }
                }
            })
        });
    }

    /// Whole minutes left in the full-logging lease, rounded up; none without a lease.
    fn minutes_left(&self) -> Option<u64> {
        let expires = self.config.as_ref()?.full_expires_at.as_deref()?;
        let at = DateTime::parse_from_rfc3339(expires).ok()?;
        let ms = (at.to_utc() - Utc::now()).num_milliseconds().max(0);
        u64::try_from((ms + 59_999) / 60_000).ok()
    }

    fn save_config(
        &mut self,
        level: String,
        categories: BTreeMap<String, String>,
        cx: &mut Context<Self>,
    ) {
        let previous = self
            .config
            .as_ref()
            .map(|config| config.effective.level.clone());
        let preset = |name: &str| PRESETS.iter().position(|preset| *preset == name);
        let lowered = previous
            .as_deref()
            .is_some_and(|previous| preset(&level) < preset(previous));
        self.level.saving = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { api::write_config(&client, &level, &categories).await },
            move |this: &mut Self, result: Result<LogConfig, Error>, cx| {
                this.level.saving = false;
                // The App's own log follows the new level (`butler:app-log-change`).
                crate::lifecycle::logs::refresh(cx);
                let copy = super::copy::get(cx);
                let saved = words(butler_ds::ui::context::Ds::get(cx).lang());
                match result {
                    Ok(next) => {
                        let freed = next.freed_bytes;
                        this.set_config(next, cx);
                        if lowered || freed > 0 {
                            let text = if freed > 0 {
                                (copy.freed)(&format_bytes(freed))
                            } else {
                                saved.saved.to_owned()
                            };
                            show(&mut this.level_toast, Toast::success(text), cx);
                        }
                    }
                    Err(_) => show(&mut this.level_toast, Toast::error(saved.save_failed), cx),
                }
            },
        );
    }

    /// `setLevel`: full logging asks first.
    fn set_level(&mut self, level: &str, cx: &mut Context<Self>) {
        let Some(config) = &self.config else {
            return;
        };
        if config.effective.level == level {
            return;
        }
        let categories = config.effective.category_levels.clone();
        if level != "full" {
            self.save_config(level.to_owned(), categories, cx);
            return;
        }
        let copy = super::copy::get(cx);
        let request = Request::new(copy.full_confirm_body)
            .title(copy.full_confirm_title)
            .confirm_label(copy.full_confirm);
        let (view, level) = (cx.entity(), level.to_owned());
        self.ctx.confirm(
            request,
            move |_, cx| {
                view.update(cx, |list, cx| list.save_config(level, categories, cx));
            },
            cx,
        );
    }

    /// `setCategoryLevel`: no level removes the override.
    fn set_category_level(&mut self, category: &str, level: Option<&str>, cx: &mut Context<Self>) {
        let Some(config) = &self.config else {
            return;
        };
        let mut categories = config.effective.category_levels.clone();
        match level {
            Some(level) => categories.insert(category.to_owned(), level.to_owned()),
            None => categories.remove(category),
        };
        let level = config.effective.level.clone();
        self.save_config(level, categories, cx);
    }

    /// 기록: `logs-level`.
    pub(super) fn level_section(
        &self,
        copy: &'static LogsCopy,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let state = if self.config.is_some() {
            SettingsSectionState::Ready
        } else if self.level.failed {
            SettingsSectionState::Error
        } else {
            SettingsSectionState::Loading
        };
        let view = cx.entity();
        let mut section =
            SettingsSection::new("logs-level", SettingsSectionKind::Form, copy.section_level)
                .state(state)
                .on_retry(cx.listener(|this, _, _, cx| this.load_config(cx)))
                .holds_fields();
        if self.config.is_some() {
            section = section
                .child(self.level_field(copy, cx))
                .child(self.category_levels(copy, &view, cx));
        }
        section
    }

    fn level_field(&self, copy: &'static LogsCopy, cx: &mut Context<Self>) -> AnyElement {
        let level = self
            .config
            .as_ref()
            .map_or("standard", |config| config.effective.level.as_str());
        let minutes = self.minutes_left();
        let full = level == "full" && minutes.is_some();
        let previous = self
            .ctx
            .state
            .read(cx)
            .slice::<Slice>()
            .and_then(|slice| slice.log_full)
            .and_then(|log_full| log_full.previous);
        let meta = match (full, PRESETS.iter().position(|preset| *preset == level)) {
            (true, _) => Some((copy.full_active)(minutes.unwrap_or(0))),
            (false, Some(index)) => Some(copy.level_meta[index].to_owned()),
            (false, None) => None,
        };
        let view = cx.entity();
        let choices = PRESETS.iter().zip(copy.levels).map(|(value, label)| {
            let choice = Choice::new(*value, label);
            if self.level.saving {
                choice.disabled()
            } else {
                choice
            }
        });
        let switch = SegmentedControl::new("logs-level-presets", copy.level_label, level)
            .options(choices)
            .on_value_change({
                let view = view.clone();
                move |value, _, cx| view.update(cx, |list, cx| list.set_level(value, cx))
            });
        let mut control = Inline::new().gap(Space::Sm).child(switch);
        if full {
            let off = Button::new("logs-level-off")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(copy.turn_off)
                .on_click(move |_, _, cx| {
                    let preset = previous_preset(previous.as_deref());
                    view.update(cx, |list, cx| list.set_level(preset, cx));
                });
            control = control.child(if self.level.saving {
                off.disabled()
            } else {
                off
            });
        }
        let mut field = SettingsField::new(copy.level_label)
            .control(control)
            .control_width(ControlWidth::Full)
            .setting_id("log-level");
        if let Some(meta) = meta {
            field = field.meta_text(meta);
        }
        field.into_any_element()
    }

    /// 분류별 수준: one collapsed row; open, one level select per known category.
    fn category_levels(
        &self,
        copy: &'static LogsCopy,
        view: &gpui::Entity<Self>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let overrides = self
            .config
            .as_ref()
            .map(|config| config.effective.category_levels.clone())
            .unwrap_or_default();
        let mut names: Vec<&String> = overrides.keys().chain(&self.rows.seen).collect();
        names.sort();
        names.dedup();
        let mut row = DisclosureRow::new("logs-category-levels", copy.categories)
            .surface(Surface::Plain)
            .open(self.level.categories_open)
            .on_toggle(cx.listener(|this, _, _, cx| {
                this.level.categories_open = !this.level.categories_open;
                cx.notify();
            }));
        if !overrides.is_empty() {
            row = row.meta((copy.categories_changed)(overrides.len()));
        }
        if !names.is_empty() {
            let fields = names.into_iter().map(|name| {
                let current = overrides.get(name).map_or("", String::as_str);
                self.category_level(name, current, copy, view)
            });
            row = row.child(Stack::new().gap(Space::Sm).children(fields));
        }
        row.into_any_element()
    }

    fn category_level(
        &self,
        name: &str,
        current: &str,
        copy: &'static LogsCopy,
        view: &gpui::Entity<Self>,
    ) -> AnyElement {
        let category = name.to_owned();
        let view = view.clone();
        let mut select =
            NativeSelect::new(gpui::SharedString::from(format!("logs-category-{name}")))
                .size(SelectSize::Sm)
                .value(current.to_owned())
                .option("", copy.category_inherit)
                .on_change(move |value, _, cx| {
                    let level = (!value.is_empty()).then_some(value);
                    view.update(cx, |list, cx| list.set_category_level(&category, level, cx));
                });
        for (value, label) in SEVERITIES.iter().zip(copy.severity) {
            select = select.option(*value, label);
        }
        if self.level.saving {
            select = select.disabled();
        }
        SettingsField::new(name.to_owned())
            .control(select)
            .into_any_element()
    }
}
