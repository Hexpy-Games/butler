//! `AutomationForm.tsx`, `AutomationModelField.tsx`, `AutomationAccessField.tsx` and
//! `AutomationBrowserFields.tsx`: the form's fields.
use std::rc::Rc;

use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldDescription, FieldError, FieldLabel};
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::layout::{Inline, Space, Stack};
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::section::Section;
use butler_ds::ui::select::{Select, SelectContent, SelectGroup, SelectItem, SelectTrigger};
use butler_ds::ui::select_button::SelectButton;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::{Input, Textarea};
use butler_ds::ui::tooltip::Align;
use gpui::{
    AnyElement, App, Context, IntoElement as _, ParentElement as _, SharedString, Window, div,
};

use super::copy::Words;
use super::model::{Field as FormField, session_options};
use super::{AutomationDetail, on_text, on_value};
use crate::ui::composer::menus::{
    AccessHandler, access_label, access_mode_icon, access_mode_options, model_display_name,
};
use crate::ui::manage::schedules::AutomationRuns;
use crate::ui::manage::schedules::labels::schedule_state;
use crate::ui::source::wire::AccessMode;
use crate::ui::widgets::anchor;

type Options = Vec<(SharedString, SharedString)>;

/// A field the scene can find.
fn tagged(name: &str, element: impl gpui::IntoElement) -> AnyElement {
    anchor(div().child(element), name).into_any_element()
}

/// The DS Select over `(value, label)` options.
fn choice(
    id: &'static str,
    value: SharedString,
    options: Options,
    on_change: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let select = Select::new(id, window, cx)
        .value(Some(value))
        .on_value_change(on_change);
    let group = options
        .into_iter()
        .fold(SelectGroup::new(), |group, (value, label)| {
            group.child(SelectItem::new(value, label))
        });
    let content = SelectContent::new().child(group);
    let trigger = select.trigger(SelectTrigger::new(format!("{id}-trigger")), &content, cx);
    let list = select.content(&content, window, cx);
    div().child(trigger).child(list).into_any_element()
}

/// `Field` over a label and its control.
pub(super) fn labelled(
    id: &'static str,
    label: &'static str,
    control: impl gpui::IntoElement,
) -> AnyElement {
    Field::new(id)
        .child(FieldLabel::new().child(label))
        .child(control)
        .into_any_element()
}

/// `choice` in a labelled field.
pub(super) fn select_field(
    id: &'static str,
    label: &'static str,
    value: SharedString,
    options: Options,
    on_change: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    labelled(id, label, choice(id, value, options, on_change, window, cx))
}

impl AutomationDetail {
    pub(super) fn title_field(&self, words: &Words, cx: &Context<Self>) -> AnyElement {
        let input = Input::new("automation-title")
            .value(self.form.title.clone())
            .placeholder(words.placeholders[0])
            .on_change(on_text(cx, |this, text| {
                text.clone_into(&mut this.form.title);
            }));
        tagged(
            "automation-title",
            labelled("automation-title-field", words.field_title, input),
        )
    }

    pub(super) fn prompt_field(&self, words: &Words, cx: &Context<Self>) -> AnyElement {
        let input = Textarea::new("automation-prompt")
            .value(self.form.prompt.clone())
            .placeholder(words.placeholders[1])
            .rows(14)
            .on_change(on_text(cx, |this, text| {
                text.clone_into(&mut this.form.prompt);
            }));
        tagged(
            "automation-prompt",
            labelled("automation-prompt-field", words.field_prompt, input),
        )
    }

    /// The "Details" section: target, model, access, timing, state and the latest runs.
    pub(super) fn details_section(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let sessions = session_options(self.ctx.navigation(cx).as_deref(), words.general_chat);
        let target = select_field(
            "automation-target",
            words.target_chat,
            self.form.target.clone(),
            sessions,
            on_value(cx, |this: &mut Self, value: SharedString| {
                if !value.is_empty() {
                    this.form.target = value;
                    this.clear_error(FormField::Form);
                }
            }),
            window,
            cx,
        );
        let form_error = FieldError::new().errors(
            self.error
                .filter(|error| error.field == FormField::Form)
                .map(|error| error.message),
        );
        Section::new("automation-details")
            .title(words.details)
            .child(target)
            .child(self.model_field(words, window, cx))
            .child(self.access_field(words, window, cx))
            .children(self.timing_fields(words, window, cx))
            .child(KeyValueRow::new(
                words.state,
                schedule_state(&self.form.state, lang),
            ))
            .child(form_error)
            .child(AutomationRuns::new(self.runs.clone()))
            .into_any_element()
    }

    /// `AutomationModelField`: an empty selection follows the target chat.
    fn model_field(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut options: Options = vec![("default".into(), words.model_default.into())];
        options.extend(self.models.iter().map(|model| {
            let label = format!("{} / {}", model.provider_label, model_display_name(model));
            (model.model_ref.clone(), label.into())
        }));
        // The unavailable override is kept, while the field shows the default.
        let value = options
            .iter()
            .find(|(value, _)| !self.form.model.is_empty() && **value == *self.form.model)
            .map_or_else(|| "default".into(), |(value, _)| value.clone());
        let on_change = on_value(cx, |this: &mut Self, value: SharedString| {
            this.form.model = if value == "default" {
                String::new()
            } else {
                value.to_string()
            };
        });
        tagged(
            "automation-model-field",
            select_field(
                "automation-model",
                words.model,
                value,
                options,
                on_change,
                window,
                cx,
            ),
        )
    }

    /// `AutomationAccessField`: the access a schedule's runs get.
    fn access_field(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (lang, mode) = (Ds::get(cx).lang(), self.form.access.clone());
        let label = Inline::new()
            .gap(Space::Xs)
            .wrap(false)
            .child(access_mode_icon(&mode, IconSize::Sm, Ds::get(cx)))
            .child(access_label(&mode, lang));
        let popover = Popover::new("automation-access", window, cx);
        let trigger = popover.trigger_fill(|toggle| {
            SelectButton::new("automation-access-trigger")
                .child(label)
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let this = cx.entity().downgrade();
        let closing = popover.clone();
        let pick: AccessHandler = Rc::new(move |mode, window, cx| {
            let mode = mode.clone();
            let _ = this.update(cx, |this, cx| {
                this.form.access = mode;
                this.clear_error(FormField::AccessMode);
                cx.notify();
            });
            closing.set_open(false, window, cx);
        });
        let options = access_mode_options("automation-access-option", &mode, &pick, cx);
        let content = popover.content(
            PopoverContent::new()
                .align(Align::Start)
                .side_offset(6.)
                .menu_size(MenuSize::Compact)
                .child(options),
            window,
            cx,
        );
        let hint = (!matches!(mode, AccessMode::ReadOnly | AccessMode::FullAccess))
            .then(|| FieldDescription::new().child(words.access_hint));
        let error = FieldError::new().errors(
            self.error
                .filter(|error| error.field == FormField::AccessMode)
                .map(|error| error.message),
        );
        let control = Stack::new()
            .gap(Space::Xs)
            .child(div().child(trigger).child(content))
            .children(hint)
            .child(error);
        tagged(
            "automation-access-field",
            labelled("automation-access-field", words.permission, control),
        )
    }

    /// `AutomationBrowserFields`: sign-in and payment for the schedule's browser runs.
    pub(super) fn browser_section(&self, words: &Words, cx: &Context<Self>) -> AnyElement {
        let [
            title,
            signin,
            signin_hint,
            payment,
            payment_hint,
            unavailable,
        ] = words.browser;
        let mut pay = Switch::new("schedule-browser-payment")
            .checked(!self.vault_unavailable && self.form.payment)
            .on_checked_change(on_value(cx, |this: &mut Self, on: bool| {
                this.form.payment = on;
            }));
        if self.vault_unavailable {
            pay = pay.disabled().disabled_reason(unavailable);
        }
        let sign = Switch::new("schedule-browser-signin")
            .checked(self.form.signin)
            .on_checked_change(on_value(cx, |this: &mut Self, on: bool| {
                this.form.signin = on;
            }));
        let row =
            |id: &'static str, label: &'static str, hint: &'static str, control: AnyElement| {
                Field::new(id)
                    .child(FieldLabel::new().child(label))
                    .child(FieldDescription::new().child(hint))
                    .child(control)
            };
        Section::new("automation-browser")
            .title(title)
            .child(row(
                "schedule-browser-signin-field",
                signin,
                signin_hint,
                sign.into_any_element(),
            ))
            .child(row(
                "schedule-browser-payment-field",
                payment,
                payment_hint,
                pay.into_any_element(),
            ))
            .into_any_element()
    }
}
