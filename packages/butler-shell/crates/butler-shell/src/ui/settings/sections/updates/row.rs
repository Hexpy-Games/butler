//! One component row (`UpdateComponentRow`, `UpdateStatusLine`, `UpdateProgressPanel`).
use std::rc::Rc;

use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, Window};

use super::copy::Words;
use super::model::{ComponentView, Progress, failure_message, format_bytes};
use crate::ui::Icon;

pub(super) type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

pub(super) struct Row<'a> {
    pub(super) status: &'a ComponentView,
    /// The component an update is running for.
    pub(super) applying: Option<&'a str>,
    /// The progress of this component, when it has one.
    pub(super) progress: Option<&'a Progress>,
    pub(super) copy: &'static Words,
    pub(super) on_apply: Handler,
    pub(super) on_cancel: Handler,
}

/// `UpdateStatusLine`
fn status_line(id: String, label: &'static str) -> AnyElement {
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .child(
            IconSlot::new()
                .size(SlotSize::Sm)
                .tone(SlotTone::Secondary)
                .child(Spinner::new(id).size(12.)),
        )
        .child(Typo::caption(label).tone(Tone::Secondary))
        .into_any_element()
}

/// `UpdateProgressPanel`: download feedback and failures; nothing for other stages.
fn progress_panel(
    id: &str,
    progress: &Progress,
    copy: &'static Words,
    cx: &App,
) -> Option<AnyElement> {
    if !matches!(progress.stage.as_str(), "downloading" | "failed") || progress.cancelled() {
        return None;
    }
    let body = if progress.stage == "failed" {
        Notice::new(
            NoticeTone::Error,
            failure_message(progress.error_code.as_deref(), copy),
        )
        .icon(icon(Icon::CircleAlert, IconSize::Sm, Ds::get(cx)))
        .into_any_element()
    } else {
        let done = progress.bytes_done.unwrap_or(0.);
        let done_text = format_bytes(done, copy);
        let meter_id = format!("{id}-progress");
        match progress.known_total() {
            Some(total) => {
                let percent = (done / total * 100.).floor().min(100.);
                let meta = copy
                    .download_meta
                    .replace("{percent}", &percent.to_string())
                    .replace("{done}", &done_text)
                    .replace("{total}", &format_bytes(total, copy));
                #[expect(clippy::cast_possible_truncation, reason = "a percent")]
                let percent = percent as f32;
                ProgressMeter::new(meter_id, percent)
                    .label(copy.downloading)
                    .meta(meta)
                    .into_any_element()
            }
            None => {
                let meter = ProgressMeter::indeterminate(meter_id).label(copy.downloading);
                match progress.bytes_done {
                    Some(_) => meter
                        .meta(copy.downloaded_bytes.replace("{done}", &done_text))
                        .into_any_element(),
                    None => meter.into_any_element(),
                }
            }
        }
    };
    Some(Stack::new().gap(Space::Xs).child(body).into_any_element())
}

/// `buttonLabel`
fn button_label(row: &Row) -> &'static str {
    let copy = row.copy;
    if row.applying == Some(row.status.component.as_str()) {
        copy.applying
    } else if row.status.update_available {
        copy.update
    } else if row.status.check_state.as_deref() == Some("unavailable") {
        copy.unavailable
    } else if row.status.check_state.as_deref() == Some("unchecked") {
        copy.checking
    } else {
        copy.up_to_date
    }
}

impl Row<'_> {
    pub(super) fn render(self, cx: &App) -> AnyElement {
        let status = self.status;
        let copy = self.copy;
        let id = format!("update-component-{}", status.component);
        let stage = match self.progress {
            Some(progress) if progress.cancelled() => "idle",
            Some(progress) => progress.stage.as_str(),
            None => "",
        };
        // CARVE-OUT(G-native): React also reads the Electron restart coordinator
        // (`useAppUpdateState`): "deferred" and "preparing/restarting/choice_required" make the
        // app row wait or busy. The shell has no such state, so only the agent's stage counts.
        let busy = matches!(stage, "checking" | "verifying" | "applying" | "restarting");
        let cancelling = stage == "downloading" && self.progress.is_some_and(|p| p.cancellable);
        let unknown_download =
            stage == "downloading" && self.progress.is_none_or(|p| p.known_total().is_none());
        let mut column = Stack::new()
            .gap(Space::Xs)
            .child(FieldLabel::new().child(copy.app))
            .child(Typo::caption(status.version_label()));
        if let Some(detail) = status.bundled_agent_label() {
            column = column.child(Typo::caption(detail));
        }
        if busy {
            let label = match stage {
                "checking" => copy.checking,
                "verifying" => copy.verifying,
                "applying" => copy.applying,
                _ => copy.restarting,
            };
            column = column.child(status_line(format!("{id}-spinner"), label));
        } else if stage == "ready" {
            column = column.child(Typo::caption(copy.ready).tone(Tone::Secondary));
        }
        let mut panel = self
            .progress
            .and_then(|progress| progress_panel(&id, progress, copy, cx));
        if unknown_download {
            column = column.children(panel.take());
        }
        let mut head = Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Md)
            .wrap(true)
            .child(column);
        if !busy && (stage != "downloading" || cancelling) {
            head = head.child(self.button(&id, stage, cancelling));
        }
        Field::new(id)
            .child(head)
            .children(panel)
            .into_any_element()
    }

    fn button(&self, id: &str, stage: &str, cancelling: bool) -> AnyElement {
        let status = self.status;
        let copy = self.copy;
        let outline = cancelling || !status.update_available;
        let blocked =
            (!status.update_available && !matches!(stage, "failed" | "ready") && !cancelling)
                || (self.applying.is_some() && stage != "ready" && !cancelling);
        let label = if cancelling {
            copy.cancel
        } else if stage == "failed" {
            copy.retry
        } else if stage == "ready" {
            copy.restart
        } else {
            button_label(self)
        };
        let handler = if cancelling {
            self.on_cancel.clone()
        } else {
            self.on_apply.clone()
        };
        let mut button = Button::new(format!("{id}-action"))
            .size(Size::Sm)
            .variant(if outline {
                Variant::Outline
            } else {
                Variant::Default
            })
            .text(label)
            .on_click(move |event, window, cx| handler(event, window, cx));
        if blocked {
            button = button.disabled();
        }
        button.into_any_element()
    }
}
