//! `ScheduleTimingFields.tsx`: the frequency, the time and weekday of a calendar schedule, or
//! the interval of a repeating one.
use butler_ds::ui::context::Ds;
use butler_ds::ui::text::Input;
use butler_ds::ui::time_picker::TimePicker;
use gpui::{AnyElement, Context, SharedString, Window};

use super::copy::Words;
use super::fields::{labelled, select_field};
use super::model::{DEFAULT_TIME, Field as FormField, INTERVALS, Slot};
use super::{AutomationDetail, on_text, on_value};

/// `scheduleFrequency({ interval_seconds })`
fn interval_label(seconds: i64, words: &Words) -> String {
    if seconds % 3600 == 0 {
        (words.every_hours)(seconds / 3600)
    } else {
        (words.every_minutes)(seconds / 60)
    }
}

impl AutomationDetail {
    pub(super) fn timing_fields(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let form = &self.form;
        let frequency = match &form.slot {
            Some(slot) if slot.daily => "daily",
            Some(slot) if slot.weekdays == [1, 2, 3, 4, 5] => "weekdays",
            Some(_) => "weekly",
            None => form.kind.as_str(),
        };
        let [interval, daily, weekdays, weekly, once] = words.kinds;
        let mut kinds = vec![
            ("interval", interval),
            ("daily", daily),
            ("weekdays", weekdays),
            ("weekly", weekly),
        ];
        if form.kind == "once" {
            kinds.push(("once", once));
        }
        let on_change = on_value(cx, |this: &mut Self, kind: SharedString| {
            let slot = match kind.as_ref() {
                "once" => return,
                "interval" => None,
                kind => {
                    let (time, tz) = this.form.slot.as_ref().map_or_else(
                        || (DEFAULT_TIME.to_owned(), this.timezone.clone()),
                        |slot| (slot.time.clone(), slot.tz.clone()),
                    );
                    let weekdays = match kind {
                        "weekdays" => vec![1, 2, 3, 4, 5],
                        "weekly" => vec![1],
                        _ => Vec::new(),
                    };
                    Some(Slot {
                        daily: kind == "daily",
                        time,
                        weekdays,
                        tz,
                    })
                }
            };
            this.form.set_slot(slot);
            this.clear_error(FormField::Form);
        });
        let options = kinds
            .into_iter()
            .map(|(value, label)| (value.into(), label.into()))
            .collect();
        let mut fields = vec![select_field(
            "automation-frequency",
            words.frequency,
            frequency.to_owned().into(),
            options,
            on_change,
            window,
            cx,
        )];
        match &form.slot {
            Some(slot) => fields.extend(Self::calendar_fields(slot, frequency, words, window, cx)),
            None if form.kind != "once" => fields.extend(self.interval_fields(words, window, cx)),
            None => {}
        }
        fields
    }

    /// The time, and for a weekly schedule the weekday.
    fn calendar_fields(
        slot: &Slot,
        frequency: &str,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let picker = TimePicker::new("automation-time", slot.time.clone(), words.pick_time)
            .locale(Ds::get(cx).lang())
            .on_value_change(on_value(cx, |this: &mut Self, time: SharedString| {
                if let Some(slot) = &mut this.form.slot {
                    time.to_string().clone_into(&mut slot.time);
                }
            }));
        let mut fields = vec![labelled("automation-time-field", words.time, picker)];
        if frequency == "weekly" {
            let day = slot.weekdays.first().copied().unwrap_or(1);
            let options = (1..=7)
                .zip(words.weekdays)
                .map(|(day, name)| (day.to_string().into(), name.into()))
                .collect();
            fields.push(select_field(
                "automation-weekday",
                words.weekday,
                day.to_string().into(),
                options,
                on_value(cx, |this: &mut Self, day: SharedString| {
                    if let (Some(slot), Ok(day)) = (&mut this.form.slot, day.parse()) {
                        slot.weekdays = vec![day];
                    }
                }),
                window,
                cx,
            ));
        }
        fields
    }

    /// The interval, and for a custom one its minutes.
    fn interval_fields(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let seconds = self.form.interval;
        let value: SharedString = if INTERVALS.contains(&seconds) {
            seconds.to_string().into()
        } else {
            "custom".into()
        };
        let custom = value == "custom";
        let mut options: Vec<(SharedString, SharedString)> = INTERVALS
            .iter()
            .map(|seconds| {
                (
                    seconds.to_string().into(),
                    interval_label(*seconds, words).into(),
                )
            })
            .collect();
        options.push(("custom".into(), words.custom.into()));
        let mut fields = vec![select_field(
            "automation-interval",
            words.field_interval,
            value,
            options,
            on_value(cx, |this: &mut Self, value: SharedString| {
                this.form.interval = value.parse().unwrap_or(900);
                this.clear_error(FormField::Form);
            }),
            window,
            cx,
        )];
        if custom {
            let input = Input::new("automation-custom-minutes")
                .value(((seconds + 30) / 60).to_string())
                .on_change(on_text(cx, |this, text| {
                    let text = text.trim();
                    let minutes = if text.is_empty() {
                        0.
                    } else {
                        text.parse().unwrap_or(f64::NAN)
                    };
                    if f64::is_finite(minutes) {
                        #[expect(
                            clippy::cast_possible_truncation,
                            reason = "clamped to 300..=86400 seconds"
                        )]
                        let interval = (f64::clamp(minutes, 5., 1440.) * 60.) as i64;
                        this.form.interval = interval;
                        this.clear_error(FormField::Form);
                    }
                }));
            fields.push(labelled(
                "automation-custom-minutes-field",
                words.custom_minutes,
                input,
            ));
        }
        fields
    }
}
